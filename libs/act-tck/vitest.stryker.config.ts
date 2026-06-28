import { mergeConfig } from "vitest/config";
import rootConfig from "../../vite.config";

/**
 * Vitest config for Stryker mutation runs of @rotorsoft/act-tck (issue #1028).
 *
 * Reuses the root alias map (workspace imports resolve to source) but narrows
 * the test scope. The TCK's factories are exercised by their consumers, so we
 * run the in-tree consumer specs that drive the TCK against the in-memory
 * adapters (no DB needed): the store/cache/logger TCK specs in @rotorsoft/act.
 * The DB-backed property TCK is not covered here — expect survivors in
 * store-property-tck.ts until a richer scope lands.
 *
 * The TCK's own all-packages-stability.spec.ts is deliberately NOT included:
 * it snapshots source TEXT read from disk, but Stryker runs `inPlace` and
 * rewrites those files with instrumentation, so the snapshot mismatches and the
 * dry run aborts with "failed tests in the initial test run". It's a meta-test
 * of the public surface, not of the TCK runner logic being mutated here anyway.
 *
 * Coverage is disabled: Stryker does its own per-test coverage instrumentation,
 * and the root config's coverage thresholds would otherwise fail this narrowed
 * run.
 */
export default mergeConfig(rootConfig, {
  test: {
    include: [
      "../act/test/store-tck.spec.ts",
      "../act/test/cache-tck.spec.ts",
      "../act/test/logger-tck.spec.ts",
    ],
    coverage: { enabled: false },
  },
});
