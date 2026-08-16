# `@rotorsoft/act-sqlite` performance evolution

This document tracks performance-relevant changes to the SQLite/libSQL
adapter. The core framework's `PERFORMANCE.md` (in
[`libs/act/PERFORMANCE.md`](../act/PERFORMANCE.md)) covers
adapter-independent optimizations; entries here are SQLite-specific.

## #1482 — `claim()` scales linearly with subscribed streams (RFC 1449 baseline)

Baseline for [RFC 1449](https://github.com/Rotorsoft/act-root/pull/1449) step 0.
Measured with `scripts/claim-scale.bench.mjs`, file-backed, 10 of N streams
actually pending:

| subscribed streams | claim latency | µs per subscribed stream |
|---|---|---|
| 100 | 1.66 ms | 16.6 |
| 1,000 | 11.50 ms | 11.5 |
| 5,000 | 54.86 ms | 11.0 |
| 10,000 | 113.17 ms | 11.3 |
| 20,000 | 232.52 ms | 11.6 |
| 50,000 | 603.55 ms | 12.1 |

**Flat cost per stream, so total cost is linear in subscribed streams —
independent of how much work is pending.** Extrapolating the slope: ~1.2 s per
claim at 100k streams, ~12 s at 1M. For the per-aggregate reaction shape
(`.to(e => ({target: e.stream}))`), subscribed streams equals aggregate count.

Two things make this worse than the raw number suggests. The probe is an N+1
in JavaScript — `claim` selects every eligible stream with no limit, then runs
one `SELECT 1 FROM events … LIMIT 1` per candidate with no early exit once
`lagging + leading` are found. And the whole loop runs inside
`transaction("write")`, so every concurrent commit serializes behind it.

For comparison, `act-pg` after #1448 sits at ~1.4 µs per subscribed stream —
roughly 8× cheaper per stream, and outside a write transaction. #1448's fix (a
sargable source predicate plus a partial `(stream, id)` index) **cannot port
here**: the probe is in JS, not SQL, so there is no planner to make sargable.
That is the case RFC 1449 exists to remove — under the proposed work set,
`claim` becomes an index scan of at most `lagging + leading` rows on both
adapters.

**Benchmark construction, two traps worth keeping:**

- Event ids are assigned in randomized order (`ORDER BY random()` over the
  stream × version cross product) so a stream's watermark lands at a random
  point in the global sequence. Seeding version-by-version, or modelling
  has-work as `at = -1`, sorts every pending stream to the front of
  `ORDER BY at ASC` and understates the cost by orders of magnitude.
- Claims lease for **0 ms**, so every iteration sees the full eligible set. At
  1 ms, the previous iteration's leases are still live whenever a claim is
  fast, the probe walks a smaller candidate set, and the measurement flatters
  itself — visible as `leased 0` at small sizes and `leased 10` only once each
  claim outlasts the lease. *(The act-pg bench still uses 1 ms and has the
  same caveat; worth aligning when its 50k/100k extension lands.)*

## ACT-1031 — per-adapter perf regression gate

The core framework gate (`libs/act/scripts/perf-bench.ts`) runs against
`InMemoryStore` — the fastest possible read/write path, with no SQL
planner, indexes, or prepared-statement cache. Adapter-level regressions
(a dropped index, a snapshot-floor read that silently degrades to a
full-stream scan — the #1024 class of bug) are invisible there. This
gate runs the same harness shape against a **real on-disk SQLite**
database (a scratch file, WAL mode — not `:memory:`).

SQLite needs no Docker, so unlike the act-pg gate this baseline is
generated locally and **checked in with real numbers** (see below).

### Harness

`scripts/perf-bench.ts` measures p50/p95/mean over a fixed iteration
count per scenario and writes `perf-result.json`. `scripts/perf-check.ts`
compares it against the checked-in `perf-baseline.json`. The `notify`
scenario from the act-pg harness is omitted — SQLite is single-node by
design and does not implement `Store.notify`.

| Scenario | What it guards |
|---|---|
| `commit: single event` | single-row durable write (WAL append, one transaction) |
| `commit: 50-event batch` | multi-row INSERT — guards against a per-event statement-prep regression |
| `load: cold replay over snapshot floor` | the **#1024 path** — cold `load()` must read only the snapshot + tail, not the whole stream |
| `drain: correlate+drain 50 events` | `claim()` + replay query + `ack()` loop |
| `query_stats: page of 50 (count+names)` | the ROW_NUMBER window / CTE plan stays indexed as the streams table grows |

### Budget

- **Metric:** p50 latency per scenario.
- **Tolerance:** p50 may rise to **1.5×** the baseline before the gate
  fails — the same budget as the core InMemory gate. Embedded SQLite has
  no network and no connection pool, so its noise band is far tighter
  than act-pg's (which gets a 2.0× budget).
- **Absolute floor:** scenarios whose **baseline** p50 is below **1.0 ms**
  skip the ratio check entirely — sub-ms ops are noise-dominated, so a
  0.2 → 0.5 ms swing (2.5×) is meaningless. They are reported but never
  fail the gate. Most of the SQLite scenarios land below the floor (see
  the baseline below), which is exactly why the floor exists.

### Rollout

The gate is **report-only** in CI (`continue-on-error: true`) until the
baseline proves stable across a few runs, then it flips to blocking.

### Baseline (seeded from a real local run)

Captured on macOS (Apple Silicon), Node 22, on-disk WAL SQLite, no other
load, via `pnpm -F @rotorsoft/act-sqlite bench:update`. Variance is real
— the budget and the floor exist precisely so a single noisy run does
not flap the gate.

| Scenario | p50 | p95 | mean | floor? |
|---|---|---|---|---|
| `commit: single event` | 0.269 ms | 0.316 ms | 0.268 ms | yes (skipped) |
| `commit: 50-event batch` | 0.975 ms | 1.094 ms | 0.990 ms | yes (skipped) |
| `load: cold replay over snapshot floor` | 0.210 ms | 0.257 ms | 0.224 ms | yes (skipped) |
| `drain: correlate+drain 50 events` | 1.112 ms | 1.267 ms | 1.129 ms | no (budgeted 1.5×) |
| `query_stats: page of 50 (count+names)` | 1.752 ms | 1.823 ms | 1.671 ms | no (budgeted 1.5×) |

Only the two above-floor scenarios (`drain`, `query_stats`) actively
gate; the three sub-ms scenarios are reported for trend-watching but
their ratio never fails the build.

### Refreshing the baseline

Run `pnpm -F @rotorsoft/act-sqlite bench:update` in a PR labeled
`perf-baseline-update`, with the rationale documented here.

## #1485 — the subscription work set: the N+1 probe is gone

The has-work probe was an N+1 **in JavaScript**, inside `transaction("write")`:
one `SELECT 1 FROM events ... LIMIT 1` per eligible subscription row, driven by
a JS loop. #1448's index fix, which halved the equivalent cost on Postgres,
has no analogue here — the round trips are the cost.

With `streams.correlated_at` (#1485) a marked row answers from the subscription
row alone: the candidate `SELECT` carries `AND (correlated_at IS NULL OR at <
correlated_at)`, so caught-up streams never reach the loop, and the rows that do
skip the probe entirely.

Measured on the same machine as the act-pg entry, 20,000 subscriptions of
which 3 have pending work, 5 claim rounds, `leaseMillis: 0`:

| | ms per claim | leases per round |
|---|---|---|
| Legacy probe (unmarked rows) | 221.5 | 3, 3, 3, 3, 3 |
| **Work set (marked rows)** | **2.2** | 3, 3, 3, 3, 3 |

**100x**, with identical work claimed. This is the measurement RFC 1449 was
written to produce: at 20k subscribed streams the embedded adapter went from
a fifth of a second per claim to noise.
