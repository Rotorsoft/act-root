# RFC 1484: a durable, single-writer correlate checkpoint

- **Status:** draft
- **Issue:** #1484
- **Author:** Rotorsoft
- **Created:** 2026-08-15

Step 1 of [RFC 1449](./1449-split-store-port.md), and a prerequisite for the work set in [RFC 1486](./1486-subscription-work-set.md).

## Motivation

`CorrelateCycle` holds `private _checkpoint = -1` **in process memory** — how far it has read the event log. Two costs follow:

- **N workers do N times the work.** Each has its own checkpoint, so each scans the same event range and issues the same `subscribe` UPSERTs. Uncoordinated, and until now unmeasured.
- **A restart guesses.** Cold start recovers the checkpoint as the subscription watermark minus a 10,000-event back-scan. The window is a heuristic, and the resume point is *derived from the subscription watermark* — precisely the coupling RFC 1449's split is meant to break.

## Public surface added

**No new port methods, and no extra store round trips.** The checkpoint rides operations the pipeline already performs:

```ts
// correlate already calls subscribe — read the checkpoint from its return
const { watermark, correlated } = await store().subscribe(targets);

// the drain already acks every cycle — persist the advance in the same call
await store().ack(leases, checkpoint);
```

- `subscribe`'s return grows `correlated: number` — additive.
- `ack` grows an optional second argument — additive, monotonic in the store, and omitting it leaves the value untouched.

Two earlier revisions were rejected on review. Dedicated `lease_correlated` / `ack_correlated` methods were surface creep every third-party adapter would have to implement. Routing through `claim`/`ack` on a reserved lane removed the methods but still cost two extra round trips per scan, and made checkpoint traffic indistinguishable from drain traffic at the port boundary — three existing specs that injected `ack` failures had to be rewritten to tell them apart.

## What this gives up

**Single-writer is not part of this.** The drain's `claim` leases *streams*, not the checkpoint, so N workers each read the same floor and each scan the same range. Durability is solved; deduplication is not.

That is a deliberate trade for zero round trips, and it still improves on the status quo: previously every worker had its *own* in-memory floor that could sit arbitrarily far behind, so they scanned *different* — and larger — ranges. A shared durable floor puts them all at the same, current position.

Mutual exclusion needs a step where exactly one worker wins, which is a store call of its own. Worth adding only if a measurement shows duplicate correlate scans cost something; RFC 1449's numbers put the win in `claim`, not correlate.

**A restart can re-scan.** The checkpoint persists on the drain's ack, so a correlate scan that finds no targets — and is therefore followed by no drain work — leaves the advance in memory only. Correctness is unaffected (the in-memory cursor still moves, and a re-scan re-derives the same targets); the cost is bounded re-reading after a restart.

## Storage: its own single-row relation

```sql
CREATE TABLE IF NOT EXISTS <table>_correlated (
  id int PRIMARY KEY DEFAULT 0,
  at bigint NOT NULL DEFAULT -1,
  leased_by text,
  leased_until timestamptz,
  CHECK (id = 0)
);
```

Created by `seed()` like every other table — seed-sync is the schema story, and this is additive.

### Why not a reserved subscription row

This was the preferred design in the ticket, on the grounds that it needs no new schema and gets leasing for free. **It was built and rejected on evidence.**

A reserved `__correlate__` row on a lane no `DrainController` declares does keep the drain away from it, and `claim`/`ack` do supply single-writer semantics. But the row is a *subscription*, so every stream-scoped operator surface counts it: `prioritize`, `reset`, `unblock`, `query_streams`, `blocked_streams`, and the audit's stream walks. The measurement:

```
libs/act/test/priority.spec.ts
  × delegates to store().prioritize and returns the count
    AssertionError: expected 2 to be 1
```

16 failures across 7 files. These are documented counts operators act on, so the leak is not cosmetic. The alternative — teaching every one of those surfaces to skip `__`-prefixed rows across three adapters — makes the exclusion an obligation every future adapter inherits, and one missed spot is a silently wrong count.

### Why not derive it from the work set

Once RFC 1486 lands, `MAX(correlated)` is available and needs no storage at all. It does not work, and the reason is worth recording so it is not re-proposed:

**`correlated` records what was *found*, not what was *read*.** A run of events resolving to no target leaves no trace on any row, so the derived floor cannot advance past one. Since correlate's scan is paged, the floor then re-reads the same page forever:

```
limit=100 run= 99 -> reached in 1 cycle
limit=100 run=100 -> NEVER REACHES the events past the run
```

Measured trailing-run lengths make this reachable rather than theoretical: at 5% reaction coverage a run of ≥100 has probability 0.59%, and at 1% coverage 36.6% — before considering that a backfill of reaction-less events produces a long run deterministically. Removing the page limit trades the livelock for rescanning the entire reaction-less prefix every cycle. No index rescues it: an index makes a wrong answer fast.

## Semantics

- **Cold start** reads the persisted value. On a first boot it is `-1`, and a full scan of an existing log would be unbounded, so the old back-scan heuristic seeds it once. From then on the checkpoint is exact and the heuristic never runs again.
- **A scan holds the lease** for its duration and releases it on every exit path, including failure. A throwing scan that parked the lease would stall correlation for *every* worker until it expired.
- **The durable value wins** over the in-memory one at the start of each scan: another worker may have advanced it.
- **A static-only app never touches it.** Correlate does not scan without dynamic resolvers, so the checkpoint stays inert and no lease is taken.
- **`ack_correlated` never regresses** the stored value and is gated on the holder, so a correlator whose lease lapsed mid-scan cannot clobber its successor's progress.

## Stability / charter impact

**Additive** — two new methods on the `Store` port. Every in-tree adapter implements them; a third-party adapter must add them, which is the usual cost of a port addition and why this RFC exists.

TCK cases run against all three adapters: round-trip an advance, never regress, one holder at a time, release without progress, ignore a lapsed holder's ack, and — the point of the separate relation — invisibility to every stream-scoped surface.

## Alternatives considered

| | Verdict |
|---|---|
| Reserved subscription row | Built and rejected — miscounts six operator surfaces (measured) |
| Dedicated `lease_correlated` / `ack_correlated` port methods | Rejected — surface creep every third-party adapter inherits |
| `claim`/`ack` on a reserved lane | Rejected — no new methods, but two extra round trips per scan, and checkpoint traffic became indistinguishable from drain traffic |
| Filter `__`-prefixed rows from those surfaces | Zero schema, but the exclusion is an obligation every future adapter inherits |
| Derive from `MAX(correlated)` | Livelocks past a reaction-less run longer than the page limit (measured) |
| Persist as an event in a reserved stream | Write amplification on the hot path, and moves the pollution to `query`/`scan` |
| **Dedicated single-row relation** | ✅ Isolated by construction; one-time additive schema |

## Open questions

Whether `_lease_millis` (30s) should be operator-tunable. It bounds how long a crashed correlator stalls correlation, and 30s matches the longest recommended `leaseMillis`. Left fixed until someone has a workload that argues otherwise — a knob nobody needs is still a knob everybody has to understand.
