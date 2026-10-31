// The root config leaves `packages/` out of coverage, so this one scopes
// coverage to the inspector's server code. It borrows the root's aliases and
// env instead of merging it, because a merge would inherit that exclude.
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
