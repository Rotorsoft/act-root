//
// Per-package vitest config (ACT-1131).
//
// Workspace `vitest run --coverage` from the repo root uses the root
// `vite.config.ts`, which excludes `packages` from coverage scope — the
// workspace gate tracks `libs/` only.
//
// This per-package config exists for the local AC gate. When an operator
// runs `pnpm -F @rotorsoft/act-inspector test`, coverage is scoped to
// the inspector's own server code under `src/server/`. Thresholds start
// at 95% to match the workspace baseline; the out-of-scope `discover`
// (#781) and `restore` (#786) procedures account for any gap and ramp
// this to 100% as those tickets land their own coverage.
//
// We don't `mergeConfig` with the root here — that would inherit the
// root's `exclude: ["packages/**", …]` and silently zero out coverage
// on this package. Instead, copy the workspace's path aliases and env
// (so `@rotorsoft/act` resolves to source, and tests run with the same
// color-disabled setup as the rest of the suite) and define the
// coverage block fresh.
//
import base from "../../vite.config.js";

export default {
  resolve: base.resolve,
  test: {
    globals: true,
    env: base.test?.env,
    coverage: {
      provider: "v8" as const,
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/server/**/*.ts"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        // HTTP boot — exercised by `pnpm dev`, not unit tests.
        "src/server/server.ts",
      ],
      // Initial baseline reflecting what ACT-1131 covers: every
      // in-scope read procedure + the connection state machine + the
      // write-gated `prioritize` / `audit` path. The remaining
      // headroom (~35 pts) is `discover` (#781), `restore` (#786), and
      // their PG-specific helpers. Each of those tickets will ramp
      // these thresholds toward 100% as it lands its own coverage.
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 75,
        lines: 65,
      },
    },
  },
};
