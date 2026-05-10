/**
 * Vitest config for spec-shaped scenario benchmarks under `bench/`.
 * Microbenchmarks (files with `bench()` blocks) sit in the same
 * directory and run via `pnpm bench:micro` (vitest bench mode); they
 * are excluded from this run because `vitest run` can't invoke
 * `bench()`.
 *
 * Run: `pnpm -F @rotorsoft/act-pg exec vitest run --config vitest.bench.config.ts`
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spec-shaped benches use `it()` + assertions and report numbers
    // via `console.table`. Listed individually so the microbench
    // files in the same `bench/` directory aren't picked up.
    include: ["bench/notify-perf.bench.ts", "bench/reaction-latency.bench.ts"],
    globals: true,
  },
});
