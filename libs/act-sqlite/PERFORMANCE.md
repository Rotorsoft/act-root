# `@rotorsoft/act-sqlite` performance evolution

This document tracks performance-relevant changes to the SQLite/libSQL
adapter. The core framework's `PERFORMANCE.md` (in
[`libs/act/PERFORMANCE.md`](../act/PERFORMANCE.md)) covers
adapter-independent optimizations; entries here are SQLite-specific.

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
