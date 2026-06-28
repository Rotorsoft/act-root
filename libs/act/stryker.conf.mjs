// @ts-check

/**
 * StrykerJS mutation testing — @rotorsoft/act (issue #1028).
 *
 * Weekly/dispatch only (see mutation.yml) — never a PR check, so a break
 * never blocks a PR or merge. `thresholds.break` is the floor below which the
 * weekly run goes red, surfacing a real mutation-score regression. Set ~6 pts
 * under the CI baseline (#1056) to absorb run-to-run noise: act baseline 85.7%.
 * Triage focus per the issue: surviving mutants on the with_snaps seek and
 * close/drain paths.
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
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  // Weekly-only gate floor (see file header). Baseline 85.7% → break 80.
  thresholds: { high: 86, low: 70, break: 80 },
  tempDirName: ".stryker-tmp",
};
