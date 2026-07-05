import { mergeConfig } from "vitest/config";
import rootConfig from "../../vite.config";

/**
 * Vitest config for Stryker mutation runs of @rotorsoft/act-http (issue
 * #1142).
 *
 * Reuses the root alias map (workspace imports resolve to source) but narrows
 * the test scope to this package's own specs (in-process HTTP servers — no
 * external service needed). Coverage is disabled: Stryker does its own
 * per-test coverage instrumentation, and the root config's coverage
 * thresholds would otherwise fail this narrowed run.
 */
export default mergeConfig(rootConfig, {
  test: {
    include: ["test/**/*.spec.ts"],
    coverage: { enabled: false },
  },
});
