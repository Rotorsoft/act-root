/**
 * Root-level config for benchmarks across all libs.
 *
 * Naming convention: shape is encoded in the filename so each glob is
 * unambiguous and the configs stay self-documenting.
 *
 *   - `*.micro.bench.ts`    → Shape A: vitest `bench()` microbenches.
 *     Run via `pnpm bench:micro` (`vitest bench --run`).
 *   - `*.scenario.bench.ts` → Shape C: vitest `it()` + assertions +
 *     `console.table`. Run via `pnpm bench:scenarios` (`vitest run`).
 *   - Plain `*.ts` under `libs/<lib>/scripts/` → Shape B: standalone
 *     tsx scripts. Not picked up by vitest; run directly with `tsx`.
 *
 * Both flavors live under `libs/<lib>/bench/` and share the workspace
 * aliases from the root `vite.config.ts`.
 */
import { mergeConfig } from "vitest/config";
import base from "./vite.config.js";

export default mergeConfig(base, {
  test: {
    include: ["libs/*/bench/**/*.scenario.bench.ts"],
    // One bench file at a time. These measure wall-clock latency, and as
    // concurrent workers they measure each other instead: a CPU-bound
    // bench next door starves a 50ms polling pump into collecting no
    // samples at all, and inflates every percentile the latency benches
    // assert on — one CI run reported an idle p95 of 516 ms against 7.6 ms
    // for the same code run alone. Serializing costs about 30% wall time
    // (the overlap parallelism was buying), which is the right trade when
    // the output feeds PERFORMANCE.md: slow numbers beat contaminated ones.
    fileParallelism: false,
    // Default reporter hides `console.log` from passing tests, so the
    // `console.table` blocks scenario benches emit never reach stdout
    // (and CI's step-summary parser captures nothing).
    reporters: ["verbose"],
    coverage: { enabled: false },
    // Benchmarks run *inside* a test as of vitest 5, so the test timeout
    // now bounds them where the bench runner used to own its own budget.
    // A 2000-event PG bench legitimately runs past the 60s default and
    // was killed mid-measurement. Benchmarks are long by nature — the
    // suite's job is to finish them, not to cap them. An explicit budget
    // rather than `0`: vitest 5 treats 0 as "use the default" here, which
    // is the 60s that was killing the run.
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    // Nested under `test` since vitest 5: a top-level `benchmark` key is
    // no longer read, which silently fell back to the default include and
    // swept up `libs/*/scripts/*.bench.mjs` — the standalone tsx scripts
    // this repo runs directly and vitest is not meant to collect (they
    // export no suite, so every one failed with "No test suite found").
    benchmark: {
      include: ["libs/*/bench/**/*.micro.bench.ts"],
    },
  },
});
