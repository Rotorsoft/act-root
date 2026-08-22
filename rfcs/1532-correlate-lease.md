# RFC 1532: lease the correlate checkpoint so one worker scans at a time

- **Status:** draft
- **Issue:** [#1532](https://github.com/Rotorsoft/act-root/issues/1532)
- **Author:** Rotorsoft
- **Created:** 2026-08-21

## Motivation

Every worker reads the whole event log looking for work, and every worker
writes the same bookkeeping about what it found.

[RFC 1484](./1484-correlate-checkpoint.md) made the correlate checkpoint
durable but explicitly stopped short of coordinating access to it: *"Nothing
leases the checkpoint, so N workers each read the same floor and each scan the
same range. Durability is solved; deduplication is not."* It closed with
*"single-writer coordination is deliberately deferred until a measurement
argues for it."*

That measurement now exists. `scripts/correlate-workers.bench.mjs` runs W real
worker processes against one Postgres with `notify` on, while a separate
process commits:

| workers | committed | events read scanning | **reads per event** | mark writes | delivered |
|---|---|---|---|---|---|
| 1 | 398 | 398 | **1.00** | 398 | 398 |
| 2 | 399 | 798 | **2.00** | 798 | 399 |
| 4 | 400 | 1600 | **4.00** | 1600 | 400 |
| 8 | 407 | 3256 | **8.00** | 3256 | 407 |

Exactly linear in both reads and writes. Nobody had seen this because every
earlier benchmark ran several Acts inside one process with `notify` off, so
only the process that committed was ever armed and only it ever scanned.

Two things make it worth fixing rather than tolerating:

**The writes cost more than the reads.** Each duplicate scan issues a duplicate
`subscribe`, landing on the same rows `claim` locks and churning a partial
index measured at only ~38% HOT ([#1523](https://github.com/Rotorsoft/act-root/issues/1523)).
So W workers multiply that index churn W-fold. #1510 measured the mark write at
roughly 1.6 ms of the 2.2 ms a one-event settle round costs.

**It scales the wrong way.** Adding workers is the framework's answer to load,
and today each one adds a full pass over the log for no delivery benefit.

Delivery itself is fine: handled counts track commits exactly at every worker
count. Leases already make delivery exactly-once. The waste is entirely in
discovery.

## Public surface added

One **capability-gated** (optional) method on `Store`:

```ts
lease_correlation?: (
  key: string,
  by: string,
  millis: number
) => Promise<boolean>;
```

Attempts to take (or renew) the correlation lease for `millis`. Returns `true`
when the caller holds it, `false` when another worker with the same `key` does.

**`key` scopes the lease to a set of interchangeable workers.** A lease is only
sound between correlators that look for the same things. Workers running the
same application are interchangeable; a worker deployed with *partial
behaviour* — a subset of the reactions — is not, and must scan for itself or
its targets are never marked. Callers derive the key from the registry; the
store treats it as opaque.

**It deliberately does not hand back the checkpoint**, though an earlier draft
did, on the reasoning that a worker taking the lease should sync its scan
position rather than re-scan. That is unsafe: the durable checkpoint is shared
by every correlator against the store, including ones with a different key, so
syncing from it would let one worker skip events another had scanned. A worker
that takes over instead re-scans from its own position — redundant, bounded by
paging, and idempotent, because marks only ever move forward.

No new exports, builder methods, lifecycle events, or exported types. Adapters
that omit it keep today's behaviour exactly: every worker scans.

`ActOptions` gains no field. The lease duration is an internal constant rather
than a knob — see *Unresolved*.

## Design

### Storage

A new relation, created by `seed()` like every other schema change:

```sql
CREATE TABLE IF NOT EXISTS <table>_correlation_lease (
  key          text PRIMARY KEY,
  leased_by    text NOT NULL,
  leased_until timestamptz NOT NULL
);
```

Its own relation rather than columns on `<table>_correlated`, because the lease
is keyed and the checkpoint is a singleton.

RFC 1484 deliberately wrote *"No lease columns: the write is a monotonic
`MAX`, so concurrent correlators converge without holding anything."* That
stays true and the checkpoint is untouched. The lease does not protect the
write; it decides who bothers scanning.

### Acquiring

One upsert, no read-modify-write race — two workers that both read an expired
lease before either wrote would both believe they hold it:

```sql
INSERT INTO <table>_correlation_lease (key, leased_by, leased_until)
VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))
ON CONFLICT (key) DO UPDATE
   SET leased_by = EXCLUDED.leased_by,
       leased_until = EXCLUDED.leased_until
 WHERE <table>_correlation_lease.leased_until < now()
    OR <table>_correlation_lease.leased_by = EXCLUDED.leased_by;
```

The `leased_by = EXCLUDED.leased_by` arm makes renewal the same statement as
acquisition: a holder keeps extending while it works, and a worker that lost
its lease to expiry simply takes it again. Zero rows affected means someone
else holds it.

### Using it

`CorrelateCycle.correlate()` gains one guard after the existing `_armed`
check, and it applies **only on the automatic paths** — the settle loop and the
poller — where the question is "should *someone* scan?".

An explicit `app.correlate()` never leases. That is not a convenience: `close`
catches up by looping until the checkpoint moves, so a scan silently skipped
because a peer held the lease would make close give up and cap its prune at a
stale position, pruning far less than the retention window asked for with
nothing to explain why.

An adapter without the method falls straight through, which is today's
behaviour.

### The key

A truncated SHA-256 over every event name the correlator reacts to, each with
the sorted names of the handlers registered for it. Event names alone would do
if reacting to an event implied doing the same thing with it, and it does not:
a worker deployed with a subset of the reactions reacts to the same events and
resolves them differently, so a shared lease would mark one set of targets and
never the other. Handler names come free, since the registry already keys
reactions by them.

### Releasing

By expiry only. No release verb on the port, and deliberately so: a crash and a
graceful shutdown then take the identical path, which means the recovery path
is the common path and gets exercised constantly rather than only in incidents.

A holder can still shorten its own lease, because re-acquiring as the same
holder renews and renewing to a millisecond releases in all but name.
`stop_correlations()` does exactly that, so a worker that stops cleanly does
not block discovery for the rest of its lease. It is best-effort and wrapped in
the Act's scoped-port context — a scoped Act would otherwise release against
the singleton store and leave its real lease held.

## Alternatives considered

**A reserved `__correlate__` subscription row, leased with the existing
`claim`/`ack`.** This is the obvious answer — no new schema, no new method,
leasing for free. RFC 1484 **built it and rejected it on evidence**: the row is
a subscription, so every stream-scoped operator surface counts it, producing 16
test failures across 7 files in `prioritize`, `reset`, `unblock`,
`query_streams`, `blocked_streams` and the audit walks. Those are numbers
operators act on. Teaching three adapters to skip `__`-prefixed rows was
rejected as an obligation every future adapter inherits, where one missed spot
is a silently wrong count. Nothing has changed to revive it.

**Re-read the durable checkpoint at the start of every pass, no lease.** Costs
one read, adds no surface, and lets a worker that was idle skip a range another
already scanned. Rejected as insufficient: workers wake together on the same
notification and scan concurrently, so they all read the same stale floor and
all scan anyway. It helps a lagging worker and does nothing for the measured
case. Worth revisiting only if the lease proves too costly.

**Key the lease globally rather than per registry.** Simpler, one row, no
hashing. Rejected on measurement: it starved a worker deployed with partial
behaviour, which showed up immediately as unrelated tests failing once the
lease landed. The failure mode is a reaction that silently never runs, which is
the worst class this framework has.

**Elect a correlator at deploy time** (an `ACT_CORRELATOR=1` env, like
`ACT_ONLY_LANES`). No coordination, no new surface, no round trip. Rejected on
operability: it makes discovery depend on a specific process staying alive,
with no automatic failover, and a misconfigured deploy with zero correlators
silently stops all reactions with nothing to detect it. The lease's TTL gives
failover for free.

**Advisory locks** (`pg_advisory_lock`). Free and fast on Postgres, and
completely non-portable — SQLite has no equivalent, so the TCK could not
express the contract and adapters would diverge.

**Partition the log between correlators** (worker N scans ids where
`id % W == N`). Removes duplication without a lease, but requires every worker
to agree on W and on its own index, which is exactly the static-membership
problem leases exist to avoid. It also breaks the checkpoint's meaning, since
there is no longer a single contiguous scanned prefix.

## Stability impact

**Additive, MINOR.** The method is optional; the orchestrator calls it through
`?.`, so every existing adapter — in-tree and third-party — keeps working with
today's behaviour. The TCK gains a suite gated on `capabilities.lease_correlation`,
following the `restore` precedent.

The schema change is additive and applied by `seed()`, consistent with
[the no-migrations decision](https://github.com/Rotorsoft/act-root/issues/1140):
seed-sync is the schema story.

**A behaviour change worth stating plainly:** with the lease in place,
correlation stops being fault-tolerant by redundancy. Today any worker can
scan, so losing one costs nothing. With a lease, discovery stalls for up to the
TTL after the holder dies. Nothing is lost — the marks are durable and the next
holder resumes from the checkpoint — but reaction latency spikes by up to the
TTL. That trade is the point of the RFC and should be visible in the docs, not
buried.

## Testing

- TCK: acquire succeeds and returns the checkpoint; a second worker gets
  `undefined`; the holder renews with the same call; the lease is acquirable
  again after expiry; the checkpoint returned matches what `subscribe`
  persisted.
- `act` unit: a worker that fails to take the lease does not scan; a worker
  that takes it syncs its checkpoint forward; an adapter without the method
  scans exactly as before.
- Recovery: kill the holder mid-run and assert discovery resumes within the
  TTL, with no events skipped.
- Benchmark: `correlate-workers.bench.mjs` before/after, with reads and writes
  per committed event expected to go flat instead of linear, and delivery
  counts unchanged.

## Results

`scripts/correlate-workers.bench.mjs`, same shape as the motivating run:

| workers | scan events before | after | mark writes before | after |
|---|---|---|---|---|
| 1 | 398 | 404 | 398 | 404 |
| 2 | 798 | **408** | 798 | **408** |
| 4 | 1600 | **409** | 1600 | **409** |
| 8 | 3256 | **409** | 3256 | **409** |

Flat instead of linear, in reads and writes both, and `handled` still tracks
commits exactly at every worker count — delivery is untouched, which was the
requirement.

`subscribe` *call* counts rise, because the "may I scan?" ping rides that
method: 398 → 1,209 at one worker, 5,670 at eight. Those are single-row upserts
replacing full log scans and bulk mark writes, so the trade is strongly
favourable in aggregate, and it is the reason the single-worker question below
is open rather than academic.

## Unresolved

**What TTL, and who chooses it.** 5 s is hard-coded. It bounds the post-crash
stall, so it wants to be small; it is renewed per pass, so it must exceed a
scan's duration or the holder loses its own lease mid-work. Losing it mid-scan
is safe — marks are idempotent and the checkpoint only moves forward — so the
worst case is the duplication that existed before this RFC. Left as a constant
rather than a knob until something argues for one.

**Whether a single-worker deployment should pay for it.** With one worker the
lease is always granted and costs one extra round trip per scan for no benefit.
Every gate is a knob or a heuristic, so the round trip stands until measured to
matter.
