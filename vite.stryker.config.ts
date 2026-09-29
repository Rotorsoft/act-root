import { mergeConfig, type ViteUserConfig } from "vitest/config";
import rootConfig from "./vite.config.js";

/**
 * Shared base for every package's `vitest.stryker.config.ts`.
 *
 * Reuses the root alias map (workspace imports resolve to source) and applies
 * the one override every mutation run needs: an empty `execArgv`.
 *
 * The root config sets `execArgv: ["--expose-gc"]` so `disposers.spec.ts` can
 * enforce its retention guarantee instead of skipping it. Node rejects
 * `--expose-gc` in a `worker_threads` `execArgv`, so it only works because
 * vitest defaults to the `forks` pool. Stryker's vitest runner hardcodes
 * `pool: "threads"` and its spread lands after `config:`, so a package config
 * cannot override the pool — every worker then fails to start and the dry run
 * dies before a single mutant is tested:
 *
 *     [vitest-pool]: Failed to start threads worker for test files <spec>
 *
 * Clearing `execArgv` is what makes the threads pool viable. The only cost is
 * that `globalThis.gc` is absent, so the gc-dependent case skips during
 * mutation runs — conservative, since a mutant it would have killed is
 * reported Survived rather than silently passing.
 *
 * `mergeConfig` concatenates arrays, so `execArgv: []` cannot clear the
 * inherited value through the merge; it has to be overwritten afterwards.
 */
export function strykerConfig(overrides: ViteUserConfig): ViteUserConfig {
  const merged = mergeConfig(rootConfig, overrides) as ViteUserConfig;
  (merged.test ??= {}).execArgv = [];
  return merged;
}
