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

**No new port methods, and no extra store round trips.** The checkpoint rides one operation the pipeline already performs:

```ts
// correlate already calls subscribe with the targets a scan discovered —
// read the checkpoint from its return, write the advance with the same call
const { watermark, correlated_at } = await store().subscribe(targets, at);
```

- `subscribe`'s return grows `correlated_at: number` — additive.
- `subscribe` grows an optional second argument of the same name — additive, monotonic in the store, and omitting it leaves the value untouched.

One name in both directions, because it is one value: correlate's own watermark, in the same id space as a subscription's `at`.

Three earlier revisions were rejected on review. Dedicated `lease_correlated` / `ack_correlated` methods were surface creep every third-party adapter would have to implement. Routing through `claim`/`ack` on a reserved lane removed the methods but still cost two extra round trips per scan, and made checkpoint traffic indistinguishable from drain traffic at the port boundary — three existing specs that injected `ack` failures had to be rewritten to tell them apart. Carrying the write on `ack` cost nothing extra but put it in the wrong hands: the drain is not the producer, and a scan that discovers no targets is followed by no drain work, so the advance would live in memory until some later cycle happened to ack — a restart in between re-scans. Writing it from `subscribe` puts the value in the call its own producer already makes, on every scan.

## What this gives up

**Single-writer is not part of this.** Nothing leases the checkpoint, so N workers each read the same floor and each scan the same range. Durability is solved; deduplication is not.

That is a deliberate trade for zero round trips, and it still improves on the status quo: previously every worker had its *own* in-memory floor that could sit arbitrarily far behind, so they scanned *different* — and larger — ranges. A shared durable floor puts them all at the same, current position. The monotonic `GREATEST` write means concurrent correlators converge rather than fight: a lagging worker's advance is ignored, never applied.

Mutual exclusion needs a step where exactly one worker wins, which is a store call of its own. Worth adding only if a measurement shows duplicate correlate scans cost something; RFC 1449's numbers put the win in `claim`, not correlate.

## Storage: its own single-row relation

```sql
CREATE TABLE IF NOT EXISTS <table>_correlated (
  id int PRIMARY KEY DEFAULT 0,
  at bigint NOT NULL DEFAULT -1,
  CHECK (id = 0)
);
```

Created by `seed()` like every other table — seed-sync is the schema story, and this is additive. No lease columns: the write is a monotonic `MAX`, so concurrent correlators need nothing to hold.

### Why not a reserved subscription row

This was the preferred design in the ticket, on the grounds that it needs no new schema and gets leasing for free. **It was built and rejected on evidence.**

A reserved `__correlate__` row on a lane no `DrainController` declares does keep the drain away from it, and `claim`/`ack` do supply single-writer semantics. But the row is a *subscription*, so every stream-scoped operator surface counts it: `prioritize`, `reset`, `unblock`, `query_streams`, `blocked_streams`, and the audit's stream walks. The measurement:

```
libs/act/test/priority.spec.ts
  × delegates to store().prioritize and returns the count
    AssertionError: expected 2 to be 1
```

16 failures across 7 files. These are documented counts operators act on, so the leak is not cosmetic. The alternative — teaching every one of those surfaces to skip `__`-prefixed rows across three adapters — makes the exclusion an obligation every future adapter inherits, and one missed spot is a silently wrong count.

### Why not derive it from the acked leases

`ack` already carries every lease's `at`, so `max(acked.at)` looks free. It is wrong, and in the one direction that loses data.

Once a target is subscribed, the drain's `claim`/`fetch` reads the log **directly** — correlate is not involved. Correlate is only the discovery mechanism, and it scans in bounded pages (`limit` 10 direct, 100 from settle). So processing routinely runs *ahead* of the read cursor. Measured on a single stream with 26 events:

```
max_acked = 25    correlate_checkpoint = 0
```

Deriving the checkpoint from the acks would jump it to 25, skipping events 1–24 **for discovery**: any dynamic target those events should have created never exists, and its reactions never run.

The asymmetry is the point. A checkpoint derived *behind* the true read position (the work-set option below) costs a re-scan. A checkpoint derived *ahead* of it silently drops work. Only correlate knows how far correlate has read, so only correlate can report it.

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
- **It advances with the scan that earned it**, in the same `subscribe` that registers the targets that scan discovered — not on a later drain, and not on a cycle that found nothing to subscribe.
- **The write is monotonic.** `GREATEST` / `MAX` in one statement: a lower or equal value is ignored rather than written, so a lagging worker cannot rewind another's progress and re-sending the same value is a no-op. Omitting the argument leaves it untouched.
- **The durable value wins** over the in-memory one at init: another worker may have advanced it.
- **A static-only app never touches it.** Correlate does not scan without dynamic resolvers, so the checkpoint stays inert.

## Stability / charter impact

**Additive** — one optional argument and one return field on `Store.subscribe`, no new methods. Every in-tree adapter implements it; a third-party adapter that ignores the argument and returns `-1` keeps working, degrading only to the previous heuristic cold start.

TCK cases run against all three adapters: round-trip an advance, persist only when greater, leave it untouched when omitted, advance in the same call that registers discovered targets, and — the point of the separate relation — invisibility to every stream-scoped surface.

## Alternatives considered

| | Verdict |
|---|---|
| Reserved subscription row | Built and rejected — miscounts six operator surfaces (measured) |
| Derive from `max(acked.at)` | Rejected — processing runs ahead of the read cursor (measured 25 vs 0), so it skips discovery |
| Dedicated `lease_correlated` / `ack_correlated` port methods | Rejected — surface creep every third-party adapter inherits |
| `claim`/`ack` on a reserved lane | Rejected — no new methods, but two extra round trips per scan, and checkpoint traffic became indistinguishable from drain traffic |
| Write it from `ack`'s optional argument | Rejected — free, but the drain is not the producer: a scan that finds no targets is followed by no ack, so the advance survives only in memory until a later cycle |
| Filter `__`-prefixed rows from those surfaces | Zero schema, but the exclusion is an obligation every future adapter inherits |
| Derive from `MAX(correlated)` | Livelocks past a reaction-less run longer than the page limit (measured) |
| Persist as an event in a reserved stream | Write amplification on the hot path, and moves the pollution to `query`/`scan` |
| **Dedicated single-row relation** | ✅ Isolated by construction; one-time additive schema |

## Open questions

None outstanding. Single-writer coordination is deliberately deferred (see *What this gives up*) until a measurement argues for it.
