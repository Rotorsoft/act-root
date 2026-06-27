// @ts-check

/**
 * StrykerJS mutation testing — @rotorsoft/act-pg (issue #1028).
 *
 * NON-BLOCKING baseline: `thresholds.break` is null, so CI reports the
 * mutation score but never fails the build.
 *
 * TODO(#1028 follow-up): once a baseline score lands, set a per-package
 * `thresholds.break` floor so a drop in mutation score fails the build.
 *
 * Requires Postgres on port 5431 — the runner executes this package's specs
 * (see vitest.stryker.config.ts).
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
  // Non-blocking: no `break` threshold yet (see file header).
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: ".stryker-tmp",
};
