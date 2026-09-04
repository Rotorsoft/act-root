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
  },
  benchmark: {
    include: ["libs/*/bench/**/*.micro.bench.ts"],
  },
});
