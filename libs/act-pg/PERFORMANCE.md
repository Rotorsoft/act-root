# `@rotorsoft/act-pg` performance evolution

This document tracks performance-relevant changes to the PostgreSQL
adapter. The core framework's `PERFORMANCE.md` (in
[`libs/act/PERFORMANCE.md`](../act/PERFORMANCE.md)) covers
adapter-independent optimizations; entries here are PG-specific.

## ACT-101 — cross-process commit→reaction latency (LISTEN/NOTIFY wakeup)

Reaction latency on poll-driven deployments is bounded below by the
correlate/drain interval (`start_correlations` default: 10 s; common
poll-loop tunings: 50–500 ms). Single-process apps can call `settle()`
directly after each `do()` and skip the poll, but cross-process
deployments — read replicas, projection workers, side-cars — cannot:
the second process has no event-loop signal that a write happened on
another node, so it has to poll.

`PostgresStore.notify` (added in this change) bridges that gap with
`LISTEN`/`NOTIFY` on a per-`(schema, table)` channel
(`act_commit_<schema>_<table>`). `commit()` issues one `NOTIFY` per
commit transaction with the full event batch as a JSON payload.
Subscribers get sub-poll wake-up; the orchestrator wires this in
automatically when the store opts in via `notify: true`. Default is
off — single-instance deployments pay zero overhead and existing
callers see no behavior change after upgrading.

Self-filter via a per-instance `_by` UUID embedded in the payload —
a store instance never receives its own commits, keeping the
`"notified"` lifecycle event a clean cross-process signal.

### Benchmark

Two `PostgresStore` instances on the same docker PG (port 5431,
`postgres:17-alpine`) simulate two processes:

- **Writer**: commits 30 single-event transactions on `stream-x` at
  30 ms intervals.
- **Reader**: an `Act` orchestrator with a reaction on the emitted
  event, target stream resolved per-source.

Two modes:

- **notify**: the reader's auto-wired `Store.notify` subscription
  triggers `settle({debounceMs: 0})` on each `notified` event.
- **polling**: notify subscription is torn down; reactions are driven
  by `setInterval(() => correlate() + drain(), 50ms)`.

Run: `pnpm -F @rotorsoft/act-pg exec vitest run --config vitest.bench.config.ts`

### Results

Numbers below are from a single run on macOS 25.4 (Apple Silicon),
docker PG on `localhost:5431`, no other load. Variance ±20 % — the
ratio is the meaningful thing.

| Mode    | p50    | p95    | p99    |
| ------- | ------ | ------ | ------ |
| notify  | 11 ms  | 15 ms  | 25 ms  |
| polling | 27 ms  | 54 ms  | 77 ms  |

Reading: notify-driven reactions land in roughly the time it takes to
complete a commit + receive a `LISTEN` notification + run a single
`settle` cycle. Polling mode adds the full interval (~POLL_INTERVAL_MS
on average for new events arriving mid-window) plus the cycle work.
At 50 ms polling, that delta is ~3× across all percentiles; at the
default `start_correlations` 10 s interval, the gap blows out to
~1000×.

### Why notify isn't always free

`LISTEN` checks out a dedicated client from the pool. Each subscribed
process holds one extra connection for the lifetime of the
subscription. For deployments running hundreds of stateless Act
processes against one PG, this is the budgeting line item to mind —
size the connection pool accordingly. There's also one extra
`pg_notify` SQL per commit on every writer that opted in. Both are
why the flag defaults off — `PostgresStore({ notify: true })` is the
explicit opt-in for multi-process deployments.

## ACT-102 research benchmark — priority-aware claim vs. dual-frontier

The dual-frontier `claim()` strategy schedules streams for processing
by watermark age (lagging frontier picks the most-behind stream;
leading frontier picks the most-fresh one). Tie-breaking when many
streams share a watermark — the typical replay-after-reset shape —
falls to PostgreSQL's physical/index order, which is undefined from
the framework's perspective.

[#673](https://github.com/Rotorsoft/act-root/issues/673) proposes a
`priority` column on the streams table so an operator can mark "this
replay matters more than the others." Before shipping the API
surface, this benchmark measures whether priority ordering
meaningfully outperforms the existing dual-frontier ordering on a
saturated workload — and whether it costs us anything elsewhere.

### Workload

- 1 source stream with 500 events.
- 50 target streams, all subscribed with watermark = -1 (cold replay
  of the same 500 events into 50 different projections).
- `streamLimit = 5`, `eventLimit = 20`. Worker is heavily saturated:
  50 candidates competing for 5 slots per claim, so any given stream
  is picked ~10 % of cycles under uniform tie-breaking.
- One target tagged `priority = 10`; the rest are `priority = 0`.
- Leading frontier disabled (set to 0) to isolate lagging-frontier
  behavior — the only place priority can change anything.

Two arms run back-to-back on identical seeded data:

- **Baseline**: live `claim()` SQL — `lag` CTE orders by `at ASC`.
- **Priority-aware**: identical SQL except `lag` orders by
  `priority DESC, at ASC`.

Each arm runs to total completion. We capture two timestamps:

- **TTF (time-to-finish)** for the priority target.
- **Total drain** time for *all* 50 targets to finish.

Run: `pnpm bench:scenarios libs/act-pg/bench/priority-claim.scenario.bench.ts`

### Results — three back-to-back runs

| Arm             | priority TTF | total drain | others @TTF (median) | others @end (median) |
| --------------- | ------------ | ----------- | -------------------- | -------------------- |
| baseline        | ~860 ms      | ~865 ms     | 500                  | 500                  |
| priority-aware  | ~80 ms       | ~785 ms     | 40                   | 500                  |

| Run | priority speedup | total drain delta |
| --- | ---------------- | ----------------- |
| 1   | 11.28×           | −6.6 %            |
| 2   | 11.40×           | −6.7 %            |
| 3   | 10.66×           | −5.3 %            |

(Negative drain delta = priority arm finished sooner overall.)

### Reading

1. **Priority target finishes ~11× faster** under saturation. With
   tied watermarks the baseline picks 5 of 50 streams essentially at
   random; the priority arm always claims the marked stream first.
2. **Total drain time is slightly *better*** with priority — about
   6 % faster end-to-end. Counter-intuitive, but cheap to explain:
   when one stream wins the lagging slot consistently, PG sees less
   row-level contention on the streams table and the workload runs
   slightly tighter.
3. **No starvation.** At the moment the priority target finished,
   non-priority targets had only acked ~40 events each (40 / 500 =
   8 % done). But they continued from there and reached the same
   end-state (median 500 acked) as the baseline arm. Reordering
   doesn't reduce the system's throughput.

### Decision

Go: the change is worth shipping. ~11× speedup on the targeted
replay, no measured downside on aggregate throughput, simple SQL
change (one `ORDER BY` clause + one column with index).

Trade-offs to document when shipping:

- Priority is **fixed at subscription time** (the resolver returns
  it). For mid-flight reprioritization, expose a small operator API
  (`app.reprioritize(streams, n)`) — the SQL primitive is just a
  one-row `UPDATE`.
- Priority is **per target stream**, not per pending event. Reordering
  *within* a stream stays forbidden — that's the per-stream ordering
  invariant, which the framework guarantees regardless of priority.
- No effect under non-saturated load. With `streamLimit ≥ candidate
  streams`, every stream gets claimed every cycle and priority never
  binds.

The wakeup is a hint, not a contract. Lost notifications (network
hiccup, pool exhaustion) are tolerated — the existing debounce/poll
path still drains correctly. So you can run with a longer poll
interval as a safety net while taking the notify happy-path latency
for free.

## ACT-1133 — bounded-memory scan via pagination

`scan` (used by `Act.restore` / `Act.transfer`) walks the source
in batches. Each call to `source.query` requests
`limit: ScanOptions.batch_size` (default 500, caller-tunable
per-call via `Act.restore(source, { batch_size })`) and
`after: <last id seen>`; the loop exits when a batch returns
fewer events than requested (source paginated, ran out) or more
than requested (`CsvFile`-style source streams everything in one
call). Adapter memory stays at O(`batch_size`) regardless of
total source size. The source's per-event
`await Promise.resolve(callback(event))` provides consumer
backpressure.

`PostgresStore` participates in this without changes — it
already honors `limit` in `pool.query`. Same for `SqliteStore`,
`InMemoryStore`, and any adapter that respects the filter.
Sources whose internal representation is already bounded
(`CsvFile` reads line-by-line) are memory-safe regardless of
what `limit` says.

### Benchmark

`libs/act-pg/scripts/iterate-pagination-rss.ts` seeds one stream
with N events, takes baseline RSS + heap with `--expose-gc`, then
walks the stream twice (single unlimited `pool.query`, then the
paginated loop) sampling `process.memoryUsage()` on a 5 ms timer.

Heap (V8 `heapUsed`) is the cleaner signal — RSS includes V8
heap-growth hysteresis, so once the buffered run has grown V8 to
peak, the subsequent paginated run inherits that RSS ceiling
even though its live JS allocation is much smaller. `heapUsed`
at the sample tick reflects current live allocations and
isolates the per-path cost.

Run: `pnpm tsx --expose-gc libs/act-pg/scripts/iterate-pagination-rss.ts`

### Results

Local docker PG (port 5431, `postgres:17-alpine`), `ROWS=500000`,
small per-event payload (`{ i: number }`), node v22.18.0.

| Path | Duration | Peak heap (Δ from baseline) | Peak RSS (Δ) |
|---|---|---|---|
| Buffered (single `pool.query`, no limit) | 1,335 ms | 258.0 MB (+246.2 MB) | 512.9 MB (+304.0 MB) |
| Paginated (`batch_size: 500` loop) | 1,970 ms | 63.6 MB (+51.7 MB) | 511.3 MB (+302.3 MB) |

**4× smaller peak heap (246.2 MB → 51.7 MB).** Wall-clock cost
is 48 % from the per-batch re-plan; for restore / transfer /
wide-export the memory ceiling is the dominant constraint, not
throughput.

Callers that already pass `limit ≤ batch_size` (aggregate
`load`, projection scan, inspector page — the framework's hot
path) hit the loop once and return after one round trip, same
as a bare `pool.query`. Operators can tune `batch_size` per
`Act.restore` call to trade round trips against memory.

## ACT-1031 — per-adapter perf regression gate

The core framework gate (`libs/act/scripts/perf-bench.ts`) runs against
`InMemoryStore` — the fastest possible read/write path, with no SQL
planner, indexes, locks, or connection pool. Adapter-level regressions
(a dropped index, a reintroduced N+1, a snapshot-floor read that
silently degrades to a full-stream scan — the #1024 class of bug) are
invisible there. This gate runs the same harness shape against a **real
Postgres** (the docker service on `localhost:5431` the test suite
already uses).

### Harness

`scripts/perf-bench.ts` measures p50/p95/mean over a fixed iteration
count per scenario and writes `perf-result.json`. `scripts/perf-check.ts`
compares it against the checked-in `perf-baseline.json`.

| Scenario | What it guards |
|---|---|
| `commit: single event` | single-row durable write (INSERT + version bump + notify, one round trip) |
| `commit: 50-event batch` | multi-row INSERT — guards against a per-event round-trip regression |
| `load: cold replay over snapshot floor` | the **#1024 path** — cold `load()` must read only the snapshot + tail, not the whole stream |
| `drain: correlate+drain 50 events` | `claim()` (FOR UPDATE SKIP LOCKED) + replay query + `ack()` competing-consumer loop |
| `query_stats: page of 50 (count+names)` | the DISTINCT ON / CTE plan stays indexed as the streams table grows |
| `notify: commit→listener latency` | cross-process LISTEN/NOTIFY commit→wakeup round trip |

### Budget

- **Metric:** p50 latency per scenario.
- **Tolerance:** p50 may rise to **2.0×** the baseline before the gate
  fails. A real DB over docker has a wide noise band (pool scheduling,
  autovacuum, OS page cache, CI neighbours); 2.0× still catches an
  order-of-magnitude regression without flapping.
- **Absolute floor:** scenarios whose **baseline** p50 is below **1.0 ms**
  skip the ratio check entirely — sub-ms ops are noise-dominated, so a
  0.3 → 0.7 ms swing (2.3×) is meaningless. They are reported but never
  fail the gate.

### Rollout

The gate is **report-only** in CI (`continue-on-error: true`) until the
baseline proves stable across a few runs, then it flips to blocking.
The baseline ships **empty** (`{"results":[]}`) — a real local Docker PG
is needed to generate it, so until CI or a maintainer runs
`pnpm -F @rotorsoft/act-pg bench:update` against `localhost:5431` every
scenario is reported as `NEW` and the gate is a no-op. **No pg numbers
have been fabricated.**

### Refreshing the baseline

Run `pnpm -F @rotorsoft/act-pg bench:update` against a real PG in a PR
labeled `perf-baseline-update`, with the rationale documented here.

### #1024 cold-load before/after (pg)

The #1024 fix made `with_snaps` reads resume at the latest `__snapshot__`
floor instead of scanning from the start of the stream, so a cache-miss
cold `load()` reads only the snapshot + tail rather than the whole history.

A/B on a real Postgres (local), single stream of **2000 pre-snapshot events
+ a snapshot + 50 tail events**, comparing the un-floored read (`after: -1`,
the pre-#1024 behavior) against the floored read (#1024), p50 over 50 iters:

| Path | p50 before #1024 (full scan) | p50 after #1024 (snapshot floor) | rows read |
|---|---|---|---|
| `query(with_snaps)` on a snapshotted stream | 5.27 ms | 0.62 ms | 2051 → 51 |

**~8.4× faster**, and the gap widens linearly with stream length (the
before-path is O(total events), the after-path O(events-since-snapshot)).
The gated `load: cold replay over snapshot floor` scenario uses a small
50/50 floor as a standing regression guard — if the floor silently breaks
and the read scans the whole stream again, its p50 climbs past tolerance.

### #1125 state projections — rebuild cost by projection shape (pg)

`projection(name).of(state).flush(handler)` folds events through the
state's own reducers in memory and flushes one row per stream per round,
so rebuild write amplification tracks the distinct-stream count instead
of the event count. Measured with
`scripts/state-projection-bench.ts` (docker PG :5431, M3 Pro): the same
100k-event store rebuilt to a real Postgres read table by all three
shapes.

Wide keys — 5,000 streams x 20 events:

| Shape | Wall-clock | Row-writes |
|---|---|---|
| per-event `.do()` | 31.0 s | 100,000 |
| `.batch()` | 0.4 s | 100,000 |
| `.of().flush()` | 2.7 s | **5,000** |

Hot keys — 50 streams x 2,000 events:

| Shape | Wall-clock | Row-writes |
|---|---|---|
| per-event `.do()` | 31.1 s | 100,000 |
| `.batch()` | 0.3 s | 100,000 |
| `.of().flush()` | **0.9 s** | **100** |

Reading the numbers honestly: `.batch()` posts competitive wall-clock
because its handler here writes raw event fields — it cannot produce a
*folded state list* without hand-rolling the fold cache, LRU and
watermark discipline that `.of()` owns; a realistic batch handler pays
reads (or re-derivation) the bench omits. On wide keys `.of()` spends
its time in per-stream head loads (one per cache miss); on hot keys
that cost amortizes across 2,000 events per stream and the shape is
both the fastest and 1,000x lighter on writes.
