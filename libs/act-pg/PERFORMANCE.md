# `@rotorsoft/act-pg` performance evolution

This document tracks performance-relevant changes to the PostgreSQL
adapter. The core framework's `PERFORMANCE.md` (in
[`libs/act/PERFORMANCE.md`](../act/PERFORMANCE.md)) covers
adapter-independent optimizations; entries here are PG-specific.

## #1448 — `claim()` was O(subscribed streams × events after watermark)

`claim()` answers "which subscribed streams have unconsumed work?" with an
`EXISTS` probe against the event log. Two properties of the SQL combined
badly:

1. The `available` CTE has no `LIMIT` and is referenced three times (twice in
   `lag`, once in `lead`), so Postgres **materializes** it — the probe ran for
   every eligible stream, not just the handful needed to fill the lease
   budget.
2. The source predicate was one disjunction:
   ```sql
   AND ( s.source IS NULL
      OR (s.source !~ '<meta>' AND e.stream = s.source)
      OR (s.source ~  '<meta>' AND e.stream ~ s.source) )
   ```
   The equality is buried inside an `OR`, so it is **not sargable**. No
   `(stream, id)` index could serve it; each probe fell back to the primary
   key and scanned forward from the stream's watermark.

The second is what made it expensive. A *dormant* aggregate — caught up, but
whose last event is old — has the longest `id > at` tail, and that tail grows
with the events table. Measured at 10k streams: `loops=10000`, ~7,523 index
rows removed per probe, 939,790 shared buffer hits to return 10 rows.

### The change

- `claim` splits `available` into four arms by **source class** (never
  processed / source-less / literal / pattern), each with a single
  planner-legible predicate. The literal arm — every per-aggregate
  `.to(e => ({target: e.stream}))` reaction, i.e. the overwhelming majority —
  becomes an index seek.
- `seed()` adds a partial index `(stream, id) WHERE name <> '__snapshot__'`,
  the complement of the existing snapshot index, so the two partition the
  table rather than overlap.

Behavior is unchanged: the four arms are mutually exclusive and return
exactly what the OR-chain did. The store TCK (147 cases, including the
pattern-source claim suite) passes untouched.

### Results

Real `PostgresStore.claim()`, 10 of N streams pending, Postgres on :5431.
Script: [`scripts/claim-scale.bench.mjs`](scripts/claim-scale.bench.mjs).

| subscribed streams | before | after | speedup |
|---|---|---|---|
| 100 | 4.39 ms | 1.96 ms | 2.2x |
| 1,000 | 213.28 ms | 3.06 ms | 70x |
| 5,000 | 5,355.01 ms | 7.56 ms | 708x |
| 10,000 | 22,345.62 ms | 12.65 ms | **1,766x** |
| 20,000 | (did not complete) | 26.41 ms | — |

### What remains linear

The per-probe cost is now flat, but the probe *count* is not: `available` is
still materialized, so the number of probes is still O(subscribed streams).
That is the residual slope above (12.65 ms → 26.41 ms from 10k to 20k) and it
is why this entry does not claim the problem is closed.

Removing it means claim no longer asking the event log at all — the drain
would read a durable "these streams have work" set maintained on the
subscription side, which correlate is already positioned to produce since it
scans events forward against a checkpoint. That is a design change, not an
index, and it is explored in [RFC 1449](../../rfcs/1449-split-store-port.md).

### Extended to 100k (#1482, RFC 1449 baseline)

Step 0 of [RFC 1449](../../rfcs/1449-split-store-port.md) re-ran this to the
sizes the residual slope was only extrapolated to. Two changes make these
numbers comparable across adapters and slightly *higher* than the table
above: claims now lease for **0 ms**, so every iteration sees the full
eligible set, and the bench reports the pending count so a shrinking
candidate set cannot hide.

| subscribed streams | claim latency | µs per subscribed stream |
|---|---|---|
| 100 | 2.56 ms | 25.6 |
| 1,000 | 3.62 ms | 3.6 |
| 10,000 | 12.08 ms | 1.2 |
| 20,000 | 23.80 ms | 1.2 |
| 50,000 | 76.15 ms | 1.5 |
| 100,000 | 180.31 ms | 1.8 |

The slope from 10k to 100k is **~1.87 µs per subscribed stream**, so the
earlier ~1.4 µs estimate was optimistic and the extrapolated "~130 ms at
100k" is really **180 ms**. The shape is confirmed: cost is linear in
subscribed streams and independent of pending work (10 pending throughout).

Why the 1-ms lease mattered: whenever a claim finished inside its own lease
window, the previous iteration's leases were still live, so the next claim
walked a smaller eligible set. The tell in the act-sqlite run was `leased 0`
at small sizes flipping to `leased 10` only once each claim outlasted the
lease (#1482).

For the cross-adapter comparison this baseline exists to establish:
`act-sqlite` measures **~11.6 µs per subscribed stream** — roughly 6× worse
per stream, and inside `transaction("write")` — with no path to an index fix,
because its probe is an N+1 in JavaScript rather than SQL. See
[`libs/act-sqlite/PERFORMANCE.md`](../act-sqlite/PERFORMANCE.md).

### Reproducing

The benchmark's data model is load-bearing. Ids are assigned in randomized
order so a stream's watermark lands at a random point in the global sequence.
Seeding events version-by-version, or modelling has-work as `at = -1`, both
sort every pending stream to the front of `ORDER BY at ASC` and understate
the cost by orders of magnitude.

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

### #1178 commit-visibility lock — closing the id gap for free

`id` is a serial: assigned at INSERT, visible at COMMIT — and every
watermark consumer (claim's has-work probe, fetch's `after`, the
correlate checkpoint) assumes id order equals visibility order. Two
concurrent commits to different streams could surface out of order and
let a watermark permanently skip an event (the classic event-store gap
problem). The append path now serializes visibility with
`pg_advisory_xact_lock(hashtext(<events table>))`.

The design converged in three steps, each benchmarked with
`scripts/commit-lock.ts` (docker PG :5431, M3 Pro, 3 runs, 500 commits):

| Scenario | Before | Naive lock | CTE window | Shipped (single-statement) |
|---|---|---|---|---|
| Sequential, 1 stream | ~1,280/s | ~1,050/s | ~1,105/s | **~1,530/s (+20%)** |
| Concurrent, 10 streams × 10 workers | ~4,500/s | ~1,380/s | ~2,570/s | **~4,760/s (parity)** |

The naive shape held the lock across the whole transaction (probe + one
INSERT round trip per event + COMMIT) and collapsed concurrent
throughput by 69%. The shipped shape makes the entire commit **two
round trips with no client round trip inside the lock window**: an
unlocked head probe (optimistic concurrency is guarded by the
`(stream, version)` unique index, not the probe), then one autocommit
statement that acquires the lock in a CTE, inserts the whole batch
(lean non-unnest plan for single-event commits), and raises the NOTIFY
as another CTE in the same statement. The lock is held only for
server-side execution plus the implicit COMMIT, and group commit
absorbs the serialized WAL flushes — so cross-stream commits overlap
everything except a sub-millisecond critical section. Sequential
commits end up *faster* than before the fix because two round trips
replaced four.

Rejected along the way (decision record in
`book/act-1178-commit-visibility.md`): a read-side xmin-horizon fence
(planner-hostile predicates on every hot read) and a shared-lock
writers / exclusive-fence readers scheme (obviated — the shipped shape
already restores full write parallelism without touching the port).

### ACT-1201 — `claim()` locks only its candidates, not the whole frontier

The pre-1201 `claim()` put `FOR UPDATE SKIP LOCKED` on the `available`
CTE with no LIMIT. A CTE carrying `FOR UPDATE` never inlines, so PG
fully materialized it and row-locked **every** claimable stream for the
transaction; the lagging/leading LIMIT was applied only afterward. A
worker claiming a handful of streams therefore locked the entire
eligible frontier — and a competing worker running concurrently
SKIP-LOCKed past all of it and got nothing, even when it wanted streams
the first worker never claimed. The starvation window scaled with the
registered-stream count.

The fix drops the lock from `available` (now a plain read), keeps the
lagging/leading selection producing `combined`, and adds a `locked` CTE
that takes `FOR UPDATE OF … SKIP LOCKED` on **only** those `combined`
candidates (re-asserting the lease-eligibility predicate under the lock
so a lease acquired between the unlocked read and the lock is never
stolen). The final `UPDATE … FROM combined` is gated on `stream IN
(SELECT stream FROM locked)`.

Measured with `scripts/claim-contention.ts` (docker PG :5431, M3 Pro,
2 workers with disjoint frontiers — one claims the lagging slice, one
the leading — over an increasingly large eligible frontier, 10 rounds,
success = **both** workers won their full 5-stream slice in the same
concurrent round):

| Frontier size | Before (both won) | After (both won) |
|---|---|---|
| 10 streams | 0% | **100%** |
| 50 streams | 0% | **100%** |
| 200 streams | 50–60% | **100%** |

Correctness is unchanged — `claim()` is still one statement plus an
implicit commit, priority/lagging/leading ordering, lane filter, retry
increment and the has-work probe all behave as before. This is a
throughput-under-contention fix: competing consumers now claim disjoint
slices of the frontier instead of serializing behind whoever locked it
first.

## #1485 — the subscription work set: `claim` stops probing the event log

`claim` answered "which subscribed streams have work?" by probing the event
log once per eligible subscription row. The cost was linear in **subscribed**
streams rather than in pending work, which is the wrong axis for the
framework's most common topology: a per-aggregate reaction
(`.to(e => ({ target: e.stream }))`) subscribes one stream per aggregate.

`correlate` already knows the answer — it walks events forward and resolves
each to its targets — and now records it as `streams.correlated_at`, the highest
event id observed to resolve to that target. Eligibility becomes `at <
correlated_at`, read from the subscription row, and the partial index
`(lane, priority DESC, at) WHERE blocked = false AND at < correlated_at` holds
only the streams with work.

Measured on docker PG :5431 (M3 Pro), 20,000 subscriptions of which 3 have
pending work, 5 claim rounds, `leaseMillis: 0` so a faster path cannot lease
fewer streams by lapping its own leases:

| | ms per claim | leases per round |
|---|---|---|
| Legacy probe (unmarked rows) | 18.1 | 3, 3, 3, 3, 3 |
| **Work set (marked rows)** | **8.7** | 3, 3, 3, 3, 3 |

**2.1x**, with identical work claimed. The remaining cost is the legacy arm
still present in the `UNION ALL` for unmarked rows; deleting it is step 5 of
RFC 1449.

The fast arm reads the base table rather than the `eligible` CTE on purpose.
That CTE is referenced by every legacy arm, so PG materializes it, and a
materialized scan cannot use the partial index the predicate was built for.

## #1487 — what always-on correlate costs a static-only app

Marking is what makes the work set work, and only `correlate` can mark, so
correlate now scans for **every** app — including the static-only apps whose
`correlate()` used to be an early-return that touched no store at all. That is
the one shape this design can cost someone, so it is measured rather than
argued about.

`scripts/static-correlate.bench.mjs`, docker PG :5431 (M3 Pro). One state, one
reaction, one constant target (`.to({ target: "projection" })`), driven through
the explicit correlate→drain pair — the loop `settle()` runs, awaited, so the
numbers don't depend on a debounce:

| shape | before (#1496) | after (#1487) | delta |
|---|---|---|---|
| catch-up — 5,000 events already in the log, drained to quiescence | 1,698 ms | 1,936 ms | **+14%** |
| steady — commit one event, catch up, repeat (200 rounds) | 5.60 ms | 7.81 ms | **+2.2 ms per round** |

Per steady-state round the app pays two extra `query` scans (the pass that
finds the new event, and the pass that finds nothing and ends the loop) plus
one `subscribe` that carries the mark. Attributed by wrapping the store:

| call | per round | ms |
|---|---|---|
| `query` | 4.00 | 1.28 |
| `claim` | 2.00 | 2.84 |
| `subscribe` | 1.00 | 1.60 |
| `ack` | 1.00 | 0.83 |
| `commit` | 1.00 | 0.69 |

The cost is per **correlate window**, not per event: batching amortizes it,
which is why the catch-up shape (≈50 events per window) pays 14% where the
one-event-per-round shape pays 40%. An app that already had a dynamic resolver
pays nothing new — it was scanning already.

### `subscribe` folded three UPDATEs into one

`subscribe` was seven round trips inside its transaction: `BEGIN`, the INSERT,
one UPDATE each for `priority`, `lane` and `correlated_at`, the checkpoint
UPDATE, the watermark SELECT, `COMMIT`. That was fine when subscribe ran only
on discovery; correlate now calls it on every scan that marks anything, so it
sits on the steady-state path for every app.

The three column UPDATEs are now one statement — `priority = GREATEST(...)`,
`lane = COALESCE(...)`, `correlated_at = GREATEST(...)` (PG's `GREATEST` reads
through a NULL on either side, so a first mark lands and an omitted one leaves
the stored value alone) — under a WHERE that still rewrites a row only when one
of the three would actually change, so the no-op case creates no dead tuples.

| | ms per `subscribe` |
|---|---|
| Three UPDATEs | 2.33 |
| **One UPDATE** | **1.60** |

### Reproducing

```bash
docker compose up -d          # PG on :5431
pnpm build
LOG_LEVEL=error node libs/act-pg/scripts/static-correlate.bench.mjs
```

`EVENTS` and `ROUNDS` override the two workload sizes. The "before" column came
from the same script run against the previous commit's build.

## #1488 — claim stops reading the event log

The has-work probe is gone. Eligibility is `at < correlated_at` on the
subscription row, served by the partial index built for it, and `claim`
issues no query against the events table at all.

`scripts/claim-scale.bench.mjs`, docker PG :5431 (M3 Pro), marks seeded the
way correlate leaves them — a pending stream marked above its watermark, a
caught-up stream marked at it — with event ids in randomized order so a
watermark lands at a random point in the global sequence:

| subscribed | 1% pending | 10% pending | 100% pending |
|---|---|---|---|
| 1,000 | 1.72 ms | 1.58 ms | 2.18 ms |
| 10,000 | 1.52 ms | 2.25 ms | 8.75 ms |
| 100,000 | **2.30 ms** | 9.16 ms | 91.37 ms |

**The headline: claim time is flat in subscribed-stream count.** At 1% pending
it is 1.7 / 1.5 / 2.3 ms from 1k to 100k. The probe's own numbers on the same
machine (#1482) were 3.62 / 12.08 / **180.31 ms** — the cost axis that grew
with domain size is gone.

What the cost tracks now is **eligible** rows, not subscribed ones: at 100%
pending, 100k streams cost 91 ms. That is the right axis — it is proportional
to the backlog rather than to how much history the app has accumulated — and
an app whose every subscription is behind has a bigger problem than claim
latency. The residual there is the fairness reserve's `NOT IN (SELECT …
LIMIT)` arm, which materializes the eligible set instead of pushing its limit
into the index; worth revisiting if a real workload lives at a high pending
fraction.

## #1510 — correlate carries the drain's armed flag

The drain has always known how to sit still: a commit raises a flag, an empty
claim lowers it, and a disarmed drain returns without touching the store.
Correlate had no equivalent, so every settle pass scanned — including the final
pass whose only job is to confirm nothing changed, and every pass on a system
where nothing is happening at all.

### What a deployment actually saves

The microbenchmark below says a parked scan is 550× cheaper per call, which is
true and not the useful number. `scripts/deployment-load.bench.mjs` runs the
real orchestrator instead: 4 worker Acts sharing one store, each with its own
settle loop on a 100 ms cadence, against a writer committing 20/s across 500
aggregates — deliberately unsaturated, because a production system spends most
of its time between bursts and that is where the cost compounds.

Identical work in both arms: 400 commits, 400 reactions handled, same latency.

| | before | after | delta |
|---|---|---|---|
| `query` calls | 136.6/s | 64.2/s | **−53%** |
| `claim` calls | 66.8/s | 24.0/s | **−64%** |
| `subscribe` calls | 57.0/s | 14.3/s | **−75%** |
| **PG tuples returned** | **54,280/s** | **18,251/s** | **−66%** |
| **PG transactions** | **322/s** | **166/s** | **−49%** |
| reaction latency p50 / p99 | 47 / 97 ms | 48 / 98 ms | unchanged |

**Half the transactions and a third of the rows read, for the same work at the
same latency.**

The `claim` drop is a second-order effect worth understanding: the settle loop
counts a correlate that advanced its cursor as progress and runs another pass.
A scan that read a window of inert events therefore bought itself an extra
drain cycle — so the wasted read was also causing wasted claims. Parking the
scan removes both.

### The microbenchmark, for completeness

`scripts/static-correlate.bench.mjs`, same host, static-only app.

| shape | before | after | delta |
|---|---|---|---|
| **idle** — one `correlate()` on a quiet system | 278.3 µs | **0.5 µs** | **550×** |
| catch-up — 5,000 events already in the log | 1,922 ms | 1,681 ms | −13% |
| steady — commit one event, catch up, repeat | 7.16 ms | 7.47 ms | +4% (noise) |

The steady-state row is unchanged on purpose: that shape commits every round,
so it arms every round and there is nothing to skip.

### The flag means "a local signal says there may be work"

It is explicitly **not** a claim that the log is unchanged. A remote writer on a
store with no `notify` support leaves this process disarmed and stale, so the
paths that exist to discover exactly that arm themselves:

- **`start_polling`** arms on every tick. Polling is the "I have no signal, go
  and look anyway" path, and parking the scan would otherwise silently strand
  every remote write on a store without notify.
- **The close cycle's catch-up** arms before scanning, because "is there an
  uncorrelated tail?" is precisely the question the flag cannot answer.

An earlier attempt gated on `after < checkpoint` as a proxy for "the caller is
deliberately rewinding". That was wrong twice: `after` is `Math.max`'d with the
checkpoint so the API cannot rewind at all, and the default `after: -1` matched
the test, so every plain `correlate()` scanned and the flag never engaged.

### Circuit-breaker interaction (#1329)

A pass that skipped the store is not evidence the store is healthy. Recording
one would re-close an OPEN breaker mid-outage and let the drain hammer a store
nobody has heard from — the #1329 bug, which #1487 closed by making correlate
always scan and this change reopens by letting it skip. Correlate now reports
whether it read anything and the settle loop gates `breaker.passed()` on that,
which is more accurate than either previous static answer.
## #1510 — the fairness reserve stops materializing the eligible set

`claim` built its candidate frontier from a CTE (`available`) referenced by
three arms. Postgres materializes a CTE referenced more than once, so every
`LIMIT` was applied to a fully-built result rather than pushing into the
partial index. `EXPLAIN` on 100,000 subscriptions, for a claim that returns 8
rows:

```
CTE available
  ->  Bitmap Heap Scan on streams  (actual rows=100000)
->  Limit  (actual rows=6)
      ->  Sort  (Sort Method: top-N heapsort)
            ->  CTE Scan on available  (actual rows=100000)
```

One hundred thousand rows read and sorted to return six.

Two changes. Each limited arm now reads the **base table** with the
eligibility predicate repeated, so the planner can stop at the limit — the
same lesson #1485 recorded for the fast arm, applied to the rest of the query.
And a second partial index orders by watermark alone, `(at) WHERE blocked =
false AND at < correlated_at`, because the fairness reserve and the leading
frontier both sort by `at` with priority ignored, which the existing
`(lane, priority DESC, at)` index cannot serve.

Isolated, on the query alone at 100k subscriptions:

| | latency | plan |
|---|---|---|
| CTE (before) | 75.6 ms | materialize 100,000, top-N sort |
| base-table rewrite only | 19.9 ms | priority arm becomes an index scan of 6 |
| **rewrite + `(at)` index** | **2.0 ms** | **both arms index scans, 6 and 2 rows** |

### End to end: claim is now flat in *both* dimensions

`scripts/claim-scale.bench.mjs`, marks seeded as correlate leaves them:

| subscribed | 1% pending | 10% pending | 100% pending |
|---|---|---|---|
| 1,000 — before | 1.72 ms | 1.58 ms | 2.18 ms |
| 1,000 — after | 2.09 ms | 1.39 ms | 1.49 ms |
| 10,000 — before | 1.52 ms | 2.25 ms | 8.75 ms |
| 10,000 — after | 1.63 ms | 1.48 ms | 1.56 ms |
| 100,000 — before | 2.30 ms | 9.16 ms | **91.37 ms** |
| 100,000 — after | **1.72 ms** | **1.57 ms** | **1.51 ms** |

#1488 made claim flat in *subscribed* streams, leaving a cost proportional to
*eligible* rows — 91 ms when everything was pending. That axis is gone too:
1.4–2.1 ms across the whole grid, whatever the hit rate.

### Under concurrent load, and the write cost

`scripts/subscription-contention.bench.mjs`, 20,000 subscriptions, 8 workers,
concurrent commits:

| | before | after |
|---|---|---|
| claim p50 | 20.69 ms | **2.52 ms** |
| claims/s | 333 | **2,186** |
| leased/s | 1,753 | **6,766** |
| HOT update % | 30% | 41% |
| index growth / 10s | 2.3 MB | 2.8 MB |
| within-run drift | 1.10× | 1.04× |

**8× the latency, 6.6× the claim throughput, 3.9× the work actually leased.**

The second index has to be paid for on a table whose write churn is the
measured pathology, so that was the thing to check rather than assume: index
growth rises 22%, which is the expected cost of one more index — and the HOT
update fraction *improved* (30% → 41%) rather than degrading, along with the
within-run drift. Claim pays tens of milliseconds once per cycle; the extra
maintenance is tens of microseconds on the same cycle.

### Caveat on lane-filtered claims

The `(at)` index does not carry `lane`, so a claim filtered to one lane scans
in watermark order and filters. Lanes partition the set, so each holds fewer
rows — but a highly selective lane on a large table will walk further than it
would with a `(lane, at)` index. Not added here: it would be a third index on
the hottest-written table, and no measured workload needs it yet.
