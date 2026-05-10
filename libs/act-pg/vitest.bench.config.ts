/**
 * Vitest config for `*.bench.ts` files. The default test run uses the
 * standard `*.{test,spec}.ts` glob — bench files are excluded so the
 * docker round-trip cost stays out of normal CI cycles. Invoke this
 * config explicitly to record performance numbers for `PERFORMANCE.md`:
 *
 *   pnpm -F @rotorsoft/act-pg exec vitest run --config vitest.bench.config.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the notify-perf bench is shaped as a vitest spec (it uses
    // `it()` and asserts a regression bound). The other `.bench.ts`
    // files in this directory are vitest-bench-mode files (run via
    // `vitest bench`), so they're excluded from this run.
    include: ["test/notify-perf.bench.ts"],
    globals: true,
  },
});
