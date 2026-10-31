/**
 * Root vitest config. Imports of `@rotorsoft/*` resolve to source, not
 * `dist/`, through `resolve.alias`, derived from the `paths` in
 * `tsconfig.workspace.json` (which `pnpm paths:sync` generates from each
 * package's `exports`), so tsc and vitest resolve the same way. An alias
 * wins over `exports`; native tsconfig paths don't, and would load a
 * subpath from `dist` beside the bare package from `src`: two copies of
 * the framework, and "failed to find the current suite".
 *
 * Vitest 5 doesn't find this file from a package directory, so each
 * package that runs vitest re-exports it from its own `vitest.config.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const root = import.meta.dirname;

// Each key becomes an anchored regex (so `@rotorsoft/act` doesn't match
// `@rotorsoft/act/x`), and exact keys come before wildcards so they win.
const { compilerOptions } = JSON.parse(
  readFileSync(resolve(root, "tsconfig.workspace.json"), "utf8")
) as { compilerOptions: { paths?: Record<string, string[]> } };
const paths = compilerOptions.paths ?? {};
const to_alias = ([key, [target]]: [string, string[]]) => ({
  find: new RegExp(
    `^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "(.*)")}$`
  ),
  replacement: resolve(root, target.replace(/\*/g, "$1")),
});
const alias = [
  ...Object.entries(paths)
    .filter(([k]) => !k.includes("*"))
    .map(to_alias),
  ...Object.entries(paths)
    .filter(([k]) => k.includes("*"))
    .map(to_alias),
];

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    // Agent worktrees under .claude hold full copies of the specs. The
    // stability spec reads `dist/`, so `pnpm check:stability` runs it.
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "test/stability.spec.ts",
    ],
    // picocolors colors output when `CI` is set, which breaks the plain-text
    // assertions on act-diagram's CLI output.
    env: {
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      // Gives each checkout its own Postgres schemas, so two worktrees
      // testing at once against the docker Postgres don't drop each other's
      // tables. Six hex characters, because the NOTIFY channel name
      // `act_commit_<schema>_<table>` must fit Postgres's 63-byte limit.
      ACT_TEST_SCHEMA_SUFFIX: createHash("sha256")
        .update(root)
        .digest("hex")
        .slice(0, 6),
    },
    // `globalThis.gc`, so `disposers.spec.ts` can check that memory is
    // released instead of skipping the case.
    execArgv: ["--expose-gc"],
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
      // 100% on every metric is the merge gate.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
