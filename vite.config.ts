/**
 * Root vitest config. `@rotorsoft/*` package paths resolve to source
 * (rather than each package's built `dist/`) via `vite-tsconfig-paths`,
 * sourced from `tsconfig.eslint.json`. New in-tree packages become
 * test-resolvable as soon as they land in that map — no `pnpm build`
 * bootstrap dance.
 *
 * The plugin's `root` and `projects` are pinned to the workspace root
 * via `import.meta.dirname` so vitest invocations from a sub-package
 * (e.g. `pnpm -F @rotorsoft/act-pg exec vitest run ...` in CI's
 * conformance jobs) still find the tsconfig — the plugin defaults
 * `root` to the CWD, which is the sub-package in that case.
 */
import { resolve } from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const workspace_root = import.meta.dirname;

export default defineConfig({
  plugins: [
    tsconfigPaths({
      root: workspace_root,
      projects: [resolve(workspace_root, "tsconfig.eslint.json")],
    }),
  ],
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
