//
// Per-package vitest config (ACT-1131).
//
// Workspace `vitest run --coverage` from the repo root uses the root
// `vite.config.ts`, which excludes `packages` from coverage scope — the
// workspace gate tracks `libs/` only.
//
// This per-package config exists for the local AC gate. When an operator
// runs `pnpm -F @rotorsoft/act-inspector test`, coverage is scoped to
// the inspector's own server code under `src/server/`.
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
      // A floor set when only the read procedures, the connection state
      // machine and the write-gated `prioritize` / `audit` path had tests.
      // Coverage is well above it now; it only stops a slide back.
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 75,
        lines: 65,
      },
    },
  },
};
