import { mergeConfig } from "vitest/config";
import rootConfig from "../../vite.config";

/**
 * Vitest config for Stryker mutation runs of @rotorsoft/act-tck (issue #1028).
 *
 * Reuses the root alias map (workspace imports resolve to source) but narrows
 * the test scope. The TCK's factories are exercised by their consumers, so we
 * run the in-tree consumer specs that drive the TCK against the in-memory
 * adapters (no DB needed): the store/cache/logger TCK specs in @rotorsoft/act
 * plus the TCK's own stability spec. The DB-backed property TCK is not covered
 * here — expect survivors in store-property-tck.ts until a richer scope lands.
 *
 * Coverage is disabled: Stryker does its own per-test coverage instrumentation,
 * and the root config's coverage thresholds would otherwise fail this narrowed
 * run.
 */
export default mergeConfig(rootConfig, {
  test: {
    include: [
      "test/**/*.spec.ts",
      "../act/test/store-tck.spec.ts",
      "../act/test/cache-tck.spec.ts",
      "../act/test/logger-tck.spec.ts",
    ],
    coverage: { enabled: false },
  },
});
