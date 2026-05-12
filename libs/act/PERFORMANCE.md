# Performance History

This document tracks the evolution of Act's performance optimizations with benchmark data. For current patterns and strategies, see the [README](libs/act/README.md).

All PostgreSQL benchmarks run against a local instance on port 5431. Each benchmark uses `vitest bench` with default iterations. Numbers vary between runs — focus on relative improvements, not absolute values.

---

## CI regression guard

A small set of hot-path scenarios runs on every PR via `pnpm -F @rotorsoft/act bench:run && pnpm -F @rotorsoft/act bench:check`. The check compares against a checked-in baseline (`libs/act/perf-baseline.json`); a scenario fails CI if its p50 exceeds 1.5× the baseline.

To refresh the baseline (only when the slowdown is intentional):

```bash
pnpm -F @rotorsoft/act bench:update    # writes perf-baseline.json
```

…and commit the change in a PR labeled `perf-baseline-update` with rationale in this document.

### Current scenarios + numbers (InMemoryStore, NODE_ENV=test)

| Scenario | p50 | ops/sec | effective |
|---|---:|---:|---:|
| `action`: single commit | 2.4 ms | 426 | — |
| `load`: warm cache hit | 1.2 ms | 848 | — |
| `load`: cold replay 100 events | 1.2 ms | 821 | — |
| `action`+`load` roundtrip | 3.7 ms | 273 | — |
| 50 concurrent commits (different streams) | 3.6 ms / batch | 278 batches/sec | **~13,900 commits/sec** |
| 20 contended commits (same stream, with retries) | 2.5 ms / batch | 401 batches/sec | **~8,000 commits/sec** |

### How to read these numbers

- **Single-stream throughput** (one user/aggregate at a time): bounded by `action` p50. ~430 commits/sec on InMemoryStore.
- **Cross-stream throughput** (many independent aggregates): scales with the event loop's parallelism. ~13,900 commits/sec on InMemoryStore at 50-way parallelism.
- **Same-stream contention** (e.g. multiplayer game shared room): bounded by optimistic-concurrency retries. ~8,000 commits/sec for 20 contending users on InMemoryStore. Real-world stores will be slower (network/disk-bound).
- **All numbers are InMemoryStore at `NODE_ENV=test`** (sleepMs=0). Production stores trade absolute throughput for durability — see `libs/act-pg/bench/*.{micro,scenario}.bench.ts` for Postgres numbers (claim, drain, watermark, contention).

> ⚠ Synthetic upper bounds. Real apps with invariants, multi-event commits, and reactions firing typically see **30–60% of these numbers**. See "Realistic workloads" below for measurements that include those costs.

---

## Realistic workloads

Run with `pnpm -F @rotorsoft/act bench:realistic`. These exercise the full pipeline real apps pay for: payload validation, invariant checking, multi-step workflows, reaction dispatch through `correlate→drain`, and projection updates. Numbers are not in the CI regression guard — they're for capacity planning.

| Scenario | p50 | per-iter | effective |
|---|---:|---:|---:|
| Ticket workflow: open → assign → close (3 actions, 3 events, 2 invariants) | 7.2 ms | 138 workflows/sec | **~414 commits/sec** |
| Calculator session: 10 key presses + projection updating (correlate+drain) | 32.3 ms | 31 sessions/sec | **~310 commits/sec** |
| Shared inventory: 10 contending reservations (same stream, invariant + retries) | 2.6 ms | 394 batches/sec | **~3,940 commits/sec** |

### Synthetic vs realistic — the gap

| Question | Synthetic upper bound | Realistic |
|---|---:|---:|
| Single-stream sequential commits | 430 /sec (`action: single commit`) | 414 /sec (3-step ticket workflow with invariants) |
| Same-stream contention | 8,000 /sec (no invariants, no reactions) | 3,940 /sec (with `stock > 0` invariant) — **~50%** |
| Multi-action with reactions firing | not measured (reactions skipped in regression guard) | 310 /sec (10 actions + correlate + drain) — **the drain cost is real** |

**Takeaway:** the regression guard's synthetic numbers are useful for catching framework slowdowns. For capacity planning, use the realistic numbers — particularly the calculator session, since "many actions + projection updating" matches most CRUD-style apps.

---

## Postgres stress test

Multi-process stress harness against a real Postgres instance. Different from the InMemoryStore guards above: this exercises true OS-level concurrency, real `FOR UPDATE SKIP LOCKED` semantics, and adapter-specific failure modes the in-process tests can't reach.

Runs on every push to `master` (and weekly via cron) via [`.github/workflows/stress.yml`](../../.github/workflows/stress.yml). Results post to the workflow run's Job Summary so they're one click from any GitHub user.

To run locally:

```bash
docker run -d --name pg-stress -p 5431:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine
pnpm -F @rotorsoft/act-pg stress
```

### Scenarios

| Scenario | Workers | What it stresses | Invariants asserted |
|---|---:|---|---|
| `commit-storm` | 8 | High commit rate across non-overlapping streams | Per-stream versions strictly monotonic from 0; no duplicates; total events = sum of worker successes |
| `same-stream` | 8 | All workers race on one stream with retries | Versions monotonic; no duplicates at same version; every commit eventually lands via `ConcurrencyError` retries |
| `drain-under-churn` | 4 + 4 | Half committing while half drain via `claim/ack` | Versions monotonic; no duplicates; no leases held past lease window; total drained = total committed |
| `killed-worker` | 6 + 2 | 2 workers `process.exit(1)` mid-commit | Versions monotonic; no duplicates; no stuck leases; surviving workers continue cleanly |

Latest results land in the workflow Summary. The harness found and forced a fix for one race in this PR: `PostgresStore.commit` now converts PG unique-violations on `(stream, version)` into `ConcurrencyError` so callers retry on the framework signal rather than an adapter-specific error.

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

## Correlation Checkpoint & Static Resolver Optimization (v0.22.0)

**PR:** #472 — Advancing correlation checkpoint + eager static subscription.

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

---

## Watermark-Aware Claim Filtering (v0.23.0)

**PR:** #474 — Skip caught-up streams in `claim()`.

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

## Drain Skip for Non-Reactive Events (v0.24.0)

**PR:** #484 — Skip drain when committed events have no registered reactions.

### Problem

`drain()` runs the full claim → query → ack cycle (3 DB round-trips) even when none of the recently committed events have registered reactions. For apps where projections handle only a subset of event types (e.g., 7 lifecycle events out of 18 total), ~61% of drain cycles do no useful work.

### Strategy: Build-time classification + runtime flag

1. **Build-time:** `_reactive_events` set collects event names with at least one registered reaction in the `Act` constructor
2. **In `do()`:** `_needs_drain` flag set when a committed event name matches `_reactive_events` (O(1) `Set.has()`)
3. **In `drain()`:** return empty result immediately when `_needs_drain` is false — zero DB round-trips
4. **Flag cleared** when drain completes with nothing acked, blocked, or errored, or when claim returns no streams
5. **Cold start:** flag set in `_init_correlation()` to ensure historical events are processed

`maxPasses` defaults to `Infinity` and acts as a kill-switch for runaway reaction loops. `settle()` exits naturally when a pass makes no progress (no new subscriptions, no acks, no blocks), so the cap rarely matters in practice — paginated catch-up after `app.reset(...)` works without manual loops.

### Benchmark (PostgreSQL, local, 18 event types / 7 reactive)

Simulates a realistic entity with 18 event types where only 7 lifecycle events have registered reactions. The remaining 11 operational events skip drain entirely.

| Scenario | ops/s | mean (ms) | Speedup |
|---|---:|---:|---|
| **Operational event (drain skipped)** | 92 | 10.9 | — |
| **Lifecycle event (full drain)** | 26 | 38.2 | — |
| **Mixed burst (3 ops + 1 lifecycle)** | 16 | 64.5 | — |
| **Operational vs lifecycle** | | | **3.51x faster** |

The 27ms saved per non-reactive cycle corresponds to the 3 DB round-trips (claim + query + ack) that are eliminated. In production with network latency to a remote database, the savings would be proportionally larger.

### InMemoryStore benchmark (for comparison)

| Scenario | ops/s | mean (ms) |
|---|---:|---:|
| **Non-reactive event (drain skipped)** | 281 | 3.6 |
| **Reactive event (full drain)** | 109 | 9.2 |
| **Improvement** | **2.58x faster** | **5.6ms saved** |

### No interface changes

Purely internal to `Act` — two new private fields (`_reactive_events`, `_needs_drain`), no Store interface changes.

---

## Batched Projection Replay

**Issue:** #556 — Optional `.batch()` handler on projections for bulk event processing.

### Problem

Projections process events one at a time during drain — each handler call is an independent async operation. When replaying large streams (rebuilding a projection, deploying a new read model, catching up after downtime), this produces N sequential writes instead of 1 batched transaction.

With PostgreSQL, a single transaction wrapping N writes is dramatically faster than N individual writes. The framework's per-event handler loop in `handle()` made it impossible to batch without working around the framework.

### Strategy

Add an optional `.batch()` method to the projection builder (static-target projections only). When defined, `drain()` calls the batch handler once with the full ordered array of all event types instead of calling individual `.do()` handlers per event.

```typescript
const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async ({ stream, data }) => { /* single-event fallback */ })
  .on({ TicketClosed })
    .do(async ({ stream, data }) => { /* single-event fallback */ })
  .batch(async (events, stream) => {
    // ALL events in one transaction — one DB round-trip
    await db.transaction(async (tx) => {
      for (const event of events) {
        switch (event.name) {
          case "TicketOpened": /* ... */ break;
          case "TicketClosed": /* ... */ break;
        }
      }
    });
  })
  .build();
```

Key design decisions:
- **Projection-level, not per-event** — one handler for all event types in a single transaction
- **Always called when defined** — even for a single event, no conditional switching
- **Static-target only** — `.batch()` available only on `projection("target")`; the Act class maps `target → batchHandler` at build time
- **Discriminated union types** — `BatchEvent<TEvents>` distributes `Committed` over each key, enabling `switch (event.name)` to narrow both `name` and `data`
- **Batch error = total rollback** — if the handler throws, `handled: 0` and watermark does not advance

### Benchmark (InMemoryStore, drain phase only, simulated 1ms I/O per handler call)

Events are pre-seeded; only the drain call is timed. Per-event handlers simulate N × 1ms async writes; the batch handler simulates 1 × 1ms for the entire batch.

| Events | Per-event drain (ms) | Batched drain (ms) | Speedup |
|---:|---:|---:|---|
| **50** | 62.7 | 4.8 | **13x** |
| **200** | 231.8 | 5.9 | **39x** |
| **500** | 573.2 | 5.9 | **97x** |

Per-event drain scales linearly (N × ~1.15ms per handler call). Batched drain is constant (~5ms) regardless of event count — one handler call plus framework overhead. The speedup is proportional to event count.

### Benchmark (PostgreSQL, drain phase only, real PG upserts)

Each handler performs a real `INSERT ... ON CONFLICT DO UPDATE` against a PG table. Per-event makes N individual writes; batched wraps all N in a single transaction.

| Events | Per-event drain | Batched drain | Speedup |
|---:|---:|---:|---|
| **1,000** | 5.7s | 294ms | **19.5x** |
| **5,000** | 27.5s | 1.4s | **19.4x** |
| **10,000** | 54.1s | 3.0s | **17.8x** |

Consistent ~19x improvement across event counts. The speedup comes from eliminating per-write transaction overhead (implicit BEGIN/COMMIT per row) and reducing network round-trips. Per-event scales linearly (~5.4ms/event); batched scales sub-linearly (~0.3ms/event) thanks to PG's transaction batching.

### Interface changes

| New API | Description |
|---|---|
| `projection("target").batch(handler)` | Register a batch handler for bulk event processing |
| `BatchEvent<TEvents>` | Distributive discriminated union type for batch handler events |
| `BatchHandler<TEvents>` | Type for batch handler functions |
| `Projection.target` | Static target string, exposed on the Projection type |
| `Projection.batchHandler` | Optional batch handler, exposed on the Projection type |

## Reaction latency (ACT-103)

How long does it take for a reaction to fire after `app.do()`? Architects evaluating Act for time-sensitive workflows ask this first; this section answers it for the single-process case. Cross-process latency (writer and reader on different boxes, both on PG) is in [`@rotorsoft/act-pg/PERFORMANCE.md`](../act-pg/PERFORMANCE.md).

### Methodology

Three steady-state scenarios. Each one wires up a single reaction whose handler records `performance.now() - committedAt` per event. Commits are spread across 256 source streams to avoid serialized contention on a single stream's version.

| Scenario | Driver | Notes |
| --- | --- | --- |
| **idle** | one commit at a time, await reaction, repeat | Measures the floor — settle debounce + correlate + drain + handler |
| **low** | 100 commits/sec sustained for 3 s | Realistic interactive workload |
| **high** | 1000 commits/sec sustained for 3 s | Stress test — reveals where InMemory saturates |

Settle runs on every `committed` event with `debounceMs: 0` so the reaction wake-up follows the local fast path (`do() → arm drain → settle`).

Run: `pnpm bench:scenarios libs/act/bench/reaction-latency.scenario.bench.ts`

### Results — InMemoryStore (single process)

Numbers below are from a single run on macOS 25.4 (Apple Silicon), no other load. Variance ±20 % — the order-of-magnitude is the meaningful thing.

| Scenario | p50 | p95 | p99 | Notes |
| --- | --- | --- | --- | --- |
| **idle** | 7 ms | 8 ms | 8 ms | Floor ≈ settle debounce + drain cycle |
| **low (100/s)** | 8 ms | 12 ms | 14 ms | Within striking distance of idle |
| **high (1000/s)** | ~1.8 s | ~3.0 s | ~3.0 s | InMemory single-threaded drain saturates — reactions queue |

### Results — PostgresStore (single process)

Same scenarios, same hardware, against the docker PG instance on
`localhost:5431`. Variance is higher than InMemory because PG round-trips
add their own jitter (autovacuum, OS scheduling, transient disk I/O).

Run: `pnpm bench:scenarios libs/act-pg/bench/reaction-latency.scenario.bench.ts`

| Scenario | p50 | p95 | p99 | Notes |
| --- | --- | --- | --- | --- |
| **idle** | 4 ms | 20 ms | 500 ms | p50 close to InMemory; tail dominated by single PG outliers (small sample) |
| **low (100/s)** | 10 ms | 22 ms | 70 ms | PG roundtrip ~5 ms baked into commit + drain |
| **high (1000/s)** | ~125 ms | ~1.2 s | ~1.5 s | Saturates faster than InMemory — PG ack overhead under concurrent commits |

**Reading the PG tail.** The idle p99 of ~500 ms is a single PG-side outlier (autovacuum kicking in, transient lock wait, etc.) magnified by the small sample count (~50–80 events). p50 is the meaningful stat for steady-state planning; p99 carries operator-facing tail-risk weight only at higher commit volumes. The framework-side regression bound asserts on p50 < 50 ms for that reason.

### Reading

1. **The floor is ~10 ms.** Settle is debounced (default 10 ms) and drain claims one batch per cycle. For interactive workloads (≤ 100 commits/sec on InMemory), latency stays close to the floor.
2. **InMemory saturates around 200 commits/sec sustained.** The 1000/sec scenario clearly shows the system can't keep up — every event waits 1–3 s in the settle queue. This is where multi-process scale-out (PG + workers) becomes structurally necessary, not just nice-to-have.
3. **Hardware-dependent.** Re-run the script on your target hardware before quoting numbers in production planning. The script is deterministic and self-contained.

### When to switch from InMemory to PG (single process)

The InMemory adapter optimizes for development feedback loops — fast cold-start, no schema, no docker. For production-grade single-process workloads:

- **At ≤ 100 commits/sec**: InMemory is fine if you accept ephemeral state (no persistence across process restart). Most apps need PG for durability anyway, so the latency comparison is moot.
- **At > 100 commits/sec sustained**: PG with single-process settle still saturates similarly because the bottleneck is the framework's drain cycle, not the store. Bigger throughput needs horizontal scale-out — see [`@rotorsoft/act-pg/PERFORMANCE.md`](../act-pg/PERFORMANCE.md) on cross-process notify and ACT-102 priority lanes.

### Out of scope

- **Browser → server → reaction round-trip** — that's an app-level concern (network, framework, etc.), not framework latency.

No Store interface changes. Batching is handled entirely at the Act orchestrator level.

---

## Auto-deprecation runtime cost (ACT-403)

The framework reads the `_v<digits>` versioning convention from the merged event registry and auto-marks legacy versions as deprecated (see [event-schema-evolution.md](../../docs/docs/architecture/event-schema-evolution.md)). The runtime piece is a single check in `action()` after the event tuples are computed: if `me._deprecated` is non-empty, scan the emitted names against the Set; warn once per name per process if any match.

The concern: this check runs on every `app.do()` call. Quantify the cost.

Run: `pnpm bench:micro libs/act/bench/deprecation-check.micro.bench.ts`

### Benchmark

| Config | hz | mean | rme |
|---|---:|---:|---:|
| No deprecation in registry | 425.11 | 2.35 ms | ±0.64% |
| With deprecation in registry (emits current version) | 423.15 | 2.36 ms | ±0.58% |

**1.00× — statistically indistinguishable.** The 0.5% delta sits inside the measurement noise (rme ±0.58–0.64%). The "with deprecation" config exercises the actual check (`Set.has` lookup for the emitted event name) and still doesn't move the needle.

### Why it's free

- **Common case bails on the first read.** Most production states have no `_v<n>` siblings, so `me._deprecated` is `undefined` → one property read + one truthy check → branch out before any loop or Set work. Zero ops per call.
- **Active deprecation path is two Set lookups.** When the state DOES carry a non-empty `_deprecated` set, the per-emit cost is one `deprecated.has(name)` + (on hit) one `warned.has(name)`. Both are O(1). The Zod validation that runs immediately after is dramatically more expensive — this check is rounding error.
- **Warning is idempotent.** Once an event name has been warned about, the `warned.has` check short-circuits and no logger call fires. Steady-state cost after first warn = same two Set lookups, no I/O.

### No CI regression baseline

The cost is below measurement noise — pinning a regression bound would be pinning noise. The check is structurally O(1) per emit and the bench is here to document the empirical floor, not to gate CI.

## Per-Act scoped ports (ACT-501)

[`ActOptions.scoped`](../../docs/docs/architecture/extension-points.md#scoped-ports-per-act) lets an Act use its own `{ store, cache }` instead of the singletons. The framework threads the bag via `AsyncLocalStorage` so internal `store()`/`cache()` calls resolve transparently. Two concerns to quantify:

1. **Per-call port read.** `store()` now does `scoped.getStore()?.store ?? _store()` on every lookup. Does the ALS check tax the hot path?
2. **Method-level wrap.** Public Act methods wrap their body in `scoped.run({store, cache}, fn)` when the Act is scoped, no-op otherwise. Does the wrap cost show up end-to-end?

Run: `pnpm bench:micro libs/act/bench/scope-overhead.micro.bench.ts`

### Port getter — one `scoped.getStore()` read

| Config | hz | mean | rme |
|---|---:|---:|---:|
| `store()` — no active scope (falls through to singleton) | 14.82M | 67 ns | ±0.04% |
| `store()` — inside `scoped.run()` (returns scoped bag) | 15.11M | 66 ns | ±0.25% |
| `cache()` — no active scope | 15.32M | 65 ns | ±0.05% |
| `cache()` — inside `scoped.run()` | 15.10M | 66 ns | ±0.18% |

**Within ±1%.** Modern Node's `AsyncLocalStorage.getStore()` is essentially a property read off the current async resource — the overlay is invisible against the cost of the getter itself.

### `app.do()` — end-to-end wrap cost

| Config | hz | mean | rme |
|---|---:|---:|---:|
| Unscoped Act (no-op wrap: `(fn) => fn()`) | 425.13 | 2.35 ms | ±0.58% |
| Scoped Act (real wrap: `scoped.run(bag, fn)`) | 427.47 | 2.34 ms | ±0.60% |

**1.01×.** The action pipeline (validate, load, patch, commit, cache) dwarfs the wrap by four orders of magnitude. The `scoped.run` binding is free at this granularity.

### `app.load()` — read-heavy path

| Config | hz | mean | rme |
|---|---:|---:|---:|
| Unscoped Act | 844.60 | 1.18 ms | ±0.76% |
| Scoped Act | 844.78 | 1.18 ms | ±0.90% |

**1.00×.** Load reads `store()` and `cache()` multiple times per call — maximum exposure to the overlay — and still shows no movement.

### Why it's free

- **`AsyncLocalStorage` in Node ≥ 16 reads from the active `AsyncResource`'s storage map** — a single property lookup, not a context-tree walk.
- **The wrap is per-method, not per-port-read.** One `scoped.run` per `app.do()` / `app.load()` call vs. potentially many internal port lookups inside it; amortizes to nothing.
- **No async-hook side effects.** `AsyncLocalStorage` no longer enables async_hooks process-wide in modern Node — only the storage is hooked.

### No CI regression baseline

Same reasoning as ACT-403: the cost is below measurement noise, so a baseline would pin noise. Bench retained as evidence that the overlay is structurally free.
