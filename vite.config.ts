/**
 * Root vitest config. `@rotorsoft/*` package paths resolve to source
 * (rather than each package's built `dist/`) via `vite-tsconfig-paths`,
 * which reads `tsconfig.eslint.json`'s `paths` map. New in-tree packages
 * become test-resolvable as soon as they're added to that map — no
 * `pnpm build` bootstrap dance, no manual alias entry per subpath.
 */
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["tsconfig.eslint.json"] })],
  test: {
    globals: true,
    // picocolors enables color emission when `CI` is set in env, which
    // wraps act-diagram CLI output in ANSI escapes and breaks
    // plain-text `toContain` assertions in format.spec/repl.spec. Force
    // picocolors off in tests so output is deterministic across local
    // and CI runs; `colors.spec.ts` mocks picocolors directly and is
    // unaffected.
    env: {
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["libs/**/src/**/*.ts"],
      exclude: [
        "**/node_modules/**",
        "packages/**",
        "**/*.tsx",
        "libs/act-diagram/src/server/**",
        "libs/act-diagram/src/client/data/**",
        "libs/act-diagram/src/client/components/**",
        "libs/act-diagram/src/client/main.tsx",
        "libs/act-diagram/src/client/types/protocol.ts",
        "libs/act-diagram/src/client/types/file-tab.ts",
        "libs/act-diagram/src/client/types/index.ts",
        "libs/act-diagram/src/index.ts",
        "libs/act-diagram/src/vite-env.d.ts",
      ],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
