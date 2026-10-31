/**
 * Benchmarks across all libs, under `libs/<lib>/bench/`. The file name says
 * how it runs: `*.micro.bench.ts` are vitest `bench()`s (`pnpm bench:micro`),
 * `*.scenario.bench.ts` are tests that print tables (`pnpm bench:scenarios`).
 */
import { mergeConfig } from "vitest/config";
import base from "./vite.config.js";

export default mergeConfig(base, {
  test: {
    include: ["libs/*/bench/**/*.scenario.bench.ts"],
    // One file at a time: benches running side by side measure each other.
    fileParallelism: false,
    // The default reporter hides the tables the scenario benches print.
    reporters: ["verbose"],
    coverage: { enabled: false },
    // A bench runs inside a test, so the 60 s default would cut a long one
    // short; vitest 5 reads 0 as the default, hence an explicit budget.
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    // Under `test` since vitest 5; a top-level key is ignored.
    benchmark: {
      include: ["libs/*/bench/**/*.micro.bench.ts"],
    },
  },
});
