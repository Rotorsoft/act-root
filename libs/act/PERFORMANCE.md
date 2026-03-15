# Performance History

This document tracks the evolution of Act's performance optimizations with benchmark data. For current patterns and strategies, see the [README](libs/act/README.md).

All PostgreSQL benchmarks run against a local instance on port 5431. Each benchmark uses `vitest bench` with default iterations. Numbers vary between runs — focus on relative improvements, not absolute values.

---

## Cache Port (v0.20.0)

**PR:** #460 — Introduced always-on `InMemoryCache` (LRU, maxSize 1000) to eliminate full event replay on `load()`.

### Strategy

Cache stores the latest state checkpoint per stream. On `load()`, only events committed after the cached position are replayed. On `action()`, the cache is updated after every successful commit. Concurrency errors invalidate stale entries.

### Why cache on every commit, not just on snap?

An alternative design would update the cache only at snap boundaries. We benchmarked both:

**Cache on every commit** (chosen):

| Events | No snap | @10 | @50 | @75 | @100 |
|---:|---:|---:|---:|---:|---:|
| **50** | 4,872 | 5,881 | 6,480 | **7,058** | 6,949 |
| **500** | **6,371** | 5,639 | 5,590 | 6,223 | 5,488 |
| **2,000** | 4,257 | **5,329** | 4,573 | 4,812 | 4,039 |

**Cache only on snap** (rejected):

| Events | No snap | @10 | @50 | @75 | @100 |
|---:|---:|---:|---:|---:|---:|
| **50** | 608 | 5,845 | 6,098 | 694 | 1,006 |
| **500** | 212 | **6,481** | 4,955 | 570 | 5,074 |
| **2,000** | 101 | **6,827** | 5,993 | 675 | 4,039 |

The snap-only strategy fails for states without `.snap()` (falls back to full replay) and has cache misses between snap boundaries. Cache-on-commit costs one `Map.set()` per commit but guarantees every `load()` after the first action is a cache hit.

**Compared to pre-cache baselines** (PG, no cache):

| Events | Without cache | With cache | Speedup |
|---:|---:|---:|---:|
| **50** | 655 | 4,872 | **7x** |
| **500** | 215 | 6,371 | **30x** |
| **2,000** | 92 | 4,257 | **46x** |

> **InMemoryStore note:** InMemory benchmarks cap at ~830 ops/s because every method starts with `await sleep(0)` to simulate async behavior. The event-loop yield costs ~1ms per call.

---

## Atomic Stream Claiming (v0.21.0)

**PR:** #471 — Replaced two-phase poll→lease drain cycle with atomic `claim()` using PostgreSQL's `FOR UPDATE SKIP LOCKED`.

### Strategy

The old drain cycle used two separate store calls: `poll()` to discover available streams, then `lease()` to lock them. Between these calls, another worker could grab the same stream — a race condition that wasted cycles.

`claim()` fuses both into a single SQL transaction using `FOR UPDATE SKIP LOCKED` — the PostgreSQL idiomatic competing consumer pattern. Workers never block each other; locked rows are silently skipped. This is the same pattern used by pgBoss, Graphile Worker, and Oban.

Also replaced `lease(leases, 0)` in `correlate()` with `subscribe()` — a clean upsert for registering reaction target streams.

### Multi-worker contention benchmark

Separate `Act` instances sharing the same PostgresStore connection pool, each with its own drain lock — simulating distributed workers competing for streams through the same database.

Each configuration seeds N streams with 5 events each, then runs W concurrent drain loops until all streams are processed. **Throughput** = total acked streams / wall-clock time. **Waste** = drain cycles that found no work (wasted DB round-trips).

| Config | poll→lease (streams/s) | claim (streams/s) | poll→lease waste | claim waste | Improvement |
|---|---:|---:|---:|---:|---|
| **1w × 100s** | 1,271 | 1,790 | 0% | 0% | **41% faster** |
| **1w × 500s** | 5,731 | 5,202 | 0% | 0% | ~same |
| **3w × 100s** | 1,081 | 892 | 11% | 13% | ~same |
| **3w × 500s** | 3,439 | 4,222 | 13% | 12% | **23% faster** |
| **5w × 100s** | 507 | 590 | 14% | 17% | **16% faster** |
| **5w × 500s** | 2,244 | 4,424 | 17% | 7% | **97% faster, waste halved** |

**Key findings:**

- The improvement scales with load — at **5 workers × 500 streams**, `claim` is **97% faster** and waste drops from 17% to 7%
- With the old poll→lease, workers would poll the same streams, then compete at the lease phase — many lose and waste the cycle
- With `claim` (`FOR UPDATE SKIP LOCKED`), each worker atomically grabs different streams in one query — no wasted discoveries
- At low concurrency (1 worker), the improvement comes from eliminating one DB round-trip per drain cycle
- At high concurrency, the improvement compounds: fewer wasted cycles × fewer DB round-trips × zero contention blocking

### Interface simplification

The Store interface was also simplified:

| Before | After |
|---|---|
| `poll(lagging, leading)` | *(removed)* |
| `lease(leases, millis)` | *(removed)* |
| — | `claim(lagging, leading, by, millis)` |
| — | `subscribe(streams)` |

Net reduction of 139 lines in the first commit, plus cleaner separation of concerns: `claim` for drain, `subscribe` for correlate, `ack`/`block` for finalization.

---

## Watermark-Aware Claim Filtering (v0.23.0)

**Issue:** #467 — Skip caught-up streams in `claim()`.

### Problem

`claim()` returned all available (unblocked, unleased) streams regardless of whether they had pending events. In steady state, most streams are caught up — drain would claim them, fetch events, find nothing, and ack with the same position. Wasted work that scales with total stream count.

### Strategy: EXISTS filter with index-friendly exact match

Add an `EXISTS` subquery to the `available` CTE in `claim()` that checks for events beyond the stream's watermark. Newly subscribed streams (`at < 0`) bypass the filter — they always need their first drain.

```sql
WHERE blocked = false
  AND (leased_by IS NULL OR leased_until <= NOW())
  AND (s.at < 0 OR EXISTS (
    SELECT 1 FROM events e
    WHERE e.id > s.at
      AND e.name <> '__snapshot__'
      AND (s.source IS NULL OR e.stream = COALESCE(s.source, s.stream))
    LIMIT 1
  ))
```

Key: uses `=` (not `~` regex) for the stream match, which leverages the `(stream, version)` unique index. Source-less subscriptions (projections) match any event.

### Benchmark (PostgreSQL, 20 drain cycles after catching up)

| Config | Baseline claimed | Filtered claimed | Baseline (ms/cycle) | Filtered (ms/cycle) | Improvement |
|---|---:|---:|---:|---:|---|
| **50 total, 5 active** | 500 | 5 | 19.1 | 2.4 | **8x faster** |
| **200 total, 10 active** | 2,161 | 12 | 23.2 | 6.9 | **3.4x faster** |
| **500 total, 10 active** | 5,209 | 18 | 21.3 | 13.0 | **64% faster** |
| **500 total, 50 active** | 5,416 | 58 | 24.0 | 15.6 | **35% faster** |

The filter eliminates wasted claims — only streams with pending events are returned. At 200 streams with 10 active, claim returns 12 instead of 2,161 (216x fewer), and the drain cycle is 3.4x faster.

---

## Correlation Checkpoint & Static Resolver Optimization (v0.22.0)

**Issue:** #465 — Advancing correlation checkpoint + eager static subscription.

### Problem

The framework already handles long streams efficiently — once a stream is subscribed, the per-stream watermark (`at`) ensures `claim()` + drain picks up new events without needing correlate. And `start_correlations()` already advances its scan position between ticks.

However, `settle()` passed a static `{ after: -1, limit: 100 }` to correlate on every call, re-scanning the same early events and re-evaluating all resolvers (static and dynamic) against already-subscribed targets. While harmless (subscribe is idempotent), this was wasted work — especially for apps with only static resolvers where correlate adds no value.

### Strategy

Three optimizations working together:

1. **Resolver classification at build time** — each reaction is tagged as static (object resolver) or dynamic (function resolver). Static resolvers have a known target at build time; dynamic resolvers depend on event data.

2. **Eager static subscription** — static resolver targets are subscribed once at init via `store().subscribe()`. The subscribed set is tracked in-memory. Correlate never re-evaluates static resolvers.

3. **Advancing checkpoint initialized from watermarks** — on cold start, `max(at)` from the streams table provides the starting position (no new checkpoint storage needed). After init, the checkpoint advances via `last_id` from correlate. `settle()` and `start_correlations()` use the shared checkpoint.

### How it works

**Cold start:**
- `_init_correlation()` reads `max(at)` from existing subscription watermarks
- Subscribes all static targets (idempotent upsert — one query)
- Sets checkpoint to `max(at)`

**Ongoing (with dynamic resolvers):**
- `correlate()` scans only from checkpoint, only evaluates dynamic resolvers
- Skips events already scanned, skips static resolvers entirely
- Checkpoint advances to `last_id`

**Ongoing (static resolvers only):**
- `correlate()` returns immediately — no event scan, no DB query
- `settle()` goes straight to `drain()`

### Benchmark

The throughput improvement for settle cycles is minimal when resolvers are cheap (`_this_` style), because the correlate scan cost is already low. The value is in correctness and scalability:

| Metric | Before | After |
|---|---|---|
| Cold-start scan position | Always -1 (beginning) | `max(at)` from watermarks |
| Static targets | Re-subscribed every correlate | Subscribed once at init |
| Dynamic resolver scan | Always from first page | From checkpoint forward |
| No-dynamic shortcut | No — always scans | Skips correlate entirely |
| Events beyond limit | Never discovered | Discovered via advancing checkpoint |

### Benchmark 1: Static-only correlate cycles (50 cycles, PG)

Apps with only static resolvers (`_this_`, `.to("target")`) — correlate is skipped entirely.

| Events | Before (ms/cycle) | After (ms/cycle) | Speedup |
|---:|---:|---:|---|
| **100** | 2.73 | 0.38 | **7.2x** |
| **500** | 2.60 | 0.39 | **6.7x** |
| **2,000** | 1.93 | 0.23 | **8.4x** |

### Benchmark 2: Dynamic resolver correlate cycles (50 cycles, PG)

Apps with dynamic resolvers — checkpoint advances past already-scanned events.

| Events | Before (ms/cycle) | After (ms/cycle) | Speedup |
|---:|---:|---:|---|
| **100** | 3.09 | 0.56 | **5.5x** |
| **500** | 4.67 | 0.43 | **10.9x** |
| **2,000** | 2.36 | 0.33 | **7.2x** |

### Benchmark 3: Cold-start first correlate (PG)

First correlate after bootstrap — reads `max(at)` from watermarks.

| Events | Before (ms) | After (ms) | Speedup |
|---:|---:|---:|---|
| **100** | 3.8 | 4.0 | ~same |
| **500** | 5.3 | 2.8 | **1.9x** |
| **2,000** | 14.8 | 7.6 | **1.9x** |

### No new interface methods

The cold-start checkpoint is read via `subscribe()` which now returns `{ subscribed, watermark }` — the watermark (max `at` across all subscriptions) is computed internally by each store adapter alongside the upsert, in a single transaction. No new Store methods, no new tables or columns.
