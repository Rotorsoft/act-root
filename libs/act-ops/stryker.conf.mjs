// @ts-check

/**
 * StrykerJS mutation testing — @rotorsoft/act-ops (issue #1142).
 *
 * Weekly/dispatch only (see mutation.yml) — never a PR check, so a break
 * never blocks a PR or merge. `thresholds.break` is the floor below which the
 * weekly run goes red, surfacing a real mutation-score regression. Set ~6 pts
 * under the baseline (the #1056 margin convention) to absorb run-to-run
 * noise: act-ops baseline 98.4%.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: "pnpm",
  // Explicit (non-glob) plugin names resolve via normal node resolution from
  // cwd. The default "@stryker-mutator/*" glob is expanded by scanning core's
  // own scope dir in pnpm's isolated store, where the runner is not a sibling.
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.stryker.config.ts",
  },
  // Instrument source in place rather than in a copied sandbox. The vitest
  // config resolves workspace imports to source via absolute-path aliases
  // (derived from the repo-root config), so a sandbox copy would be tested
  // against the un-mutated real source. In-place instrumentation (restored on
  // exit) is what makes mutations to src/ actually exercised by the suite.
  inPlace: true,
  coverageAnalysis: "perTest",
  mutate: ["src/**/*.ts", "!src/**/*.d.ts"],
  reporters: ["clear-text", "progress", "json", "html"],
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  // Weekly-only gate floor (see file header). Baseline 98.4% → break 92.
  thresholds: { high: 98, low: 90, break: 92 },
  tempDirName: ".stryker-tmp",
};
