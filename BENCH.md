# Benchmark index

Every benchmark in the workspace, what it measures, how to run it, and where the deeper writeup lives.

## How benchmarks are organized

Three shapes — pick by what you need:

| Shape | Lives in | Run command | Output | Use when |
| --- | --- | --- | --- | --- |
| **A — microbench** | `libs/<pkg>/bench/*.micro.bench.ts` (uses `bench()` from vitest) | `pnpm bench:micro` | vitest's stats table (mean / p99 / variance / "X× faster than Y") | Comparing implementations of a tight inner loop (delta vs JSON-patch, snap intervals, drain skip vs no-skip). Quick to run, stable enough for relative comparisons. |
| **B — research script** | `libs/<pkg>/scripts/*.ts` (top-level `await`, ends with `process.exit(0)`) | `npx tsx libs/<pkg>/scripts/<file>.ts` | `console.log` markdown tables | Exploring a question that doesn't fit `bench()` — e.g., multi-worker contention sweeps, schema rewrites under load. Manual, ad-hoc. |
| **C — scenario bench** | `libs/<pkg>/bench/*.scenario.bench.ts` (uses `it()` + assertions) | `pnpm bench:scenarios` | `console.table` summary + pass/fail | Realistic end-to-end scenarios with a regression bound (cross-process notify latency, priority claim ordering, reaction latency). CI runs these on PRs. |

Shape is encoded in the filename so each glob is unambiguous and the workspace config (`vitest.bench.config.ts`) can route both flavors with one file — `benchmark.include` for `*.micro.bench.ts`, `test.include` for `*.scenario.bench.ts`.

## Single-command summaries

```sh
pnpm bench:micro       # all Shape A across the workspace
pnpm bench:scenarios   # all Shape C across the workspace
```

Both invocations run a single root-level vitest process — no `pnpm -r` fan-out, so output is clean and unprefixed.

## Inventory

### `@rotorsoft/act`

| File | Shape | Measures | Notes |
| --- | --- | --- | --- |
| `bench/cache.micro.bench.ts` | A | `load()` performance with snap intervals (10 / 50 / 75 / 100 events / no snap), at stream lengths 50 / 500 / 2000 events | Validates that snapshots help with cold loads. |
| `bench/drain-skip.micro.bench.ts` | A | drain after a non-reactive event (skip optimization) vs reactive event | Documents the [drain-skip optimization](./libs/act/PERFORMANCE.md#drain-skip-for-non-reactive-events-v0240) (~3× faster). |
| `bench/batch-projection.scenario.bench.ts` | C | per-event drain vs batched drain at 50 / 200 / 500 events | Documents the [batched projection replay](./libs/act/PERFORMANCE.md#batched-projection-replay) (~10–100× faster). |
| `bench/reaction-latency.scenario.bench.ts` | C | commit→reaction latency (p50 / p95 / p99) at idle / 100/sec / 1000/sec on `InMemoryStore` | **ACT-103**. Built-in regression bound: idle p99 < 50 ms. See [Reaction latency](./libs/act/PERFORMANCE.md#reaction-latency-act-103). |
| `scripts/perf-bench.ts` | B | JSON-output regression baseline (commit / load / drain throughput) | CI regression guard via `bench:run` + `bench:check`. Baseline lives in `libs/act/perf-baseline.json`. |
| `scripts/realistic-bench.ts` | B | Multi-aggregate workload throughput | Manual sanity check before releases. |

### `@rotorsoft/act-pg`

| File | Shape | Measures | Notes |
| --- | --- | --- | --- |
| `bench/cache.micro.bench.ts` | A | `load()` perf with snap intervals on PG | PG-specific cache validation. |
| `bench/claim.micro.bench.ts` | A | atomic claim throughput | Validates [`FOR UPDATE SKIP LOCKED`](./libs/act/PERFORMANCE.md#atomic-stream-claiming-v0210). |
| `bench/drain-scale.micro.bench.ts` | A | drain throughput at 100 / 500 streams × 1 / 3 / 5 workers | Horizontal scale shape. |
| `bench/drain-skip.micro.bench.ts` | A | drain after non-reactive event (skip optimization) on PG | PG-specific skip validation. |
| `bench/batch-projection.micro.bench.ts` | A | per-event vs batched drain on PG with real `INSERT ... ON CONFLICT` | Documents the ~19× speedup from batched transactions. |
| `bench/notify-perf.scenario.bench.ts` | C | cross-process commit→reaction latency, notify vs polling | **ACT-101**. Built-in regression bound: notify p99 < polling p99. See [`act-pg/PERFORMANCE.md`](./libs/act-pg/PERFORMANCE.md#act-101--cross-process-commitreaction-latency-listennotify-wakeup). |
| `bench/priority-claim.scenario.bench.ts` | C | priority-aware claim vs dual-frontier baseline | **ACT-102**. Validates per-stream priority lanes during saturated drain. See [`libs/act/PERFORMANCE.md`](./libs/act/PERFORMANCE.md). |
| `bench/reaction-latency.scenario.bench.ts` | C | single-process commit→reaction latency on PG, idle / 100 per sec / 1000 per sec | **ACT-103**. Built-in regression bound: idle p50 < 50 ms. Numbers in [`libs/act/PERFORMANCE.md`](./libs/act/PERFORMANCE.md#reaction-latency-act-103). |
| `scripts/correlate-checkpoint.ts` | B | three sub-benchmarks for the correlate checkpoint optimization | Validates [correlate-checkpoint](./libs/act/PERFORMANCE.md#correlation-checkpoint--static-resolver-optimization-v0220) deltas. |
| `scripts/drain-contention.ts` | B | many workers × many streams, measuring waste/throughput | Operational research. |
| `scripts/watermark-claim.ts` | B | claim performance with many subscribed streams | Validates [watermark-aware claim filtering](./libs/act/PERFORMANCE.md#watermark-aware-claim-filtering-v0230). |
| `test/stress/runner.ts` | (custom) | end-to-end stress harness | Run via `pnpm -F @rotorsoft/act-pg stress`. |

### `@rotorsoft/act-patch`

| File | Shape | Measures | Notes |
| --- | --- | --- | --- |
| `bench/delta.micro.bench.ts` | A | act-patch's `delta` vs JSON Merge Patch (RFC 7396) generator | Validates the immutable-deep-merge-patch performance story. |
| `bench/patch.micro.bench.ts` | A | act-patch apply vs RFC 7396 vs json-patch (RFC 6902), sequential 10 patches | Comparison against established standards. |

## CI integration

`bench:scenarios` runs on every PR via `.github/workflows/ci-cd.yml`. Results are appended to the workflow's step summary so reviewers see the numbers at the top of the workflow page. Built-in regression assertions in each Shape C bench fail the build on order-of-magnitude regressions.

`bench:micro` and Shape B scripts are **not** run in CI — vitest bench's variance on shared runners (>50%) would produce constant false alarms, and Shape B scripts are research tools without regression bounds.

`@rotorsoft/act`'s `bench:run` + `bench:check` (the JSON-baseline regression guard) does run in CI and is independent of this index. It's the original throughput regression guard from before the Shape A/B/C split was formalized.

## Related deep writeups

- [`libs/act/PERFORMANCE.md`](./libs/act/PERFORMANCE.md) — historical optimizations (cache, atomic claim, correlate checkpoint, watermark filter, drain skip, batched replay), reaction latency.
- [`libs/act-pg/PERFORMANCE.md`](./libs/act-pg/PERFORMANCE.md) — PG-specific: cross-process notify (ACT-101), priority lanes (ACT-102).
