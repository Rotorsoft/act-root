/**
 * Vitest config for spec-shaped scenario benchmarks (`*.bench.ts` files
 * that use `it()` + assertions and report numbers via `console.table`).
 *
 * The default test run uses the standard `*.{test,spec}.ts` glob —
 * scenario benches are excluded so per-test fixture cost stays out of
 * normal CI cycles. Microbenchmarks (`*.bench.ts` with `bench()`) run
 * via `pnpm bench:micro` (vitest bench mode) and are excluded here.
 *
 * Run: `pnpm -F @rotorsoft/act exec vitest run --config vitest.bench.config.ts`
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scenario-shaped benches under `bench/` use `it()` + assertions
    // and are picked up by `pnpm bench:scenarios`. Microbench files
    // (with `bench()` blocks) live in the same directory and run via
    // `pnpm bench:micro` (vitest bench mode) — they're not included
    // here because vitest run can't invoke `bench()`.
    include: ["bench/reaction-latency.bench.ts"],
    globals: true,
  },
});
