/**
 * Root vitest config. Test imports of the published `@rotorsoft/*` packages
 * resolve to **source** (not each package's built `dist/`) via
 * `resolve.alias` — the vitest-recommended way to wire workspace deps to
 * source (vitest-dev/vitest#5517). New in-tree packages become
 * test-resolvable as soon as they land in the map — no `pnpm build`
 * bootstrap dance.
 *
 * Why `resolve.alias` and not the native `resolve.tsconfigPaths` option:
 * native tsconfig-paths *respects* each package's `exports` map, so subpath
 * imports of an `exports`-bearing package (e.g. `@rotorsoft/act-http/hono`)
 * resolve to `dist` while the bare package resolves to `src` — two copies
 * of the framework load and vitest fails with "failed to find the current
 * suite" (a dual-package hazard, vitest-dev/vitest#7465). `resolve.alias`
 * takes precedence over `exports`, forcing uniform src resolution.
 *
 * The alias map is *derived* from the `paths` in `tsconfig.workspace.json` —
 * the single source of truth, also consumed by `tsc --noEmit` — so the
 * type-checker and the test runner can never drift. Those `paths` are
 * themselves generated from each package's `exports` map by
 * `scripts/derive-tsconfig-paths.mjs` (`pnpm paths:sync`; CI runs
 * `pnpm paths:check`), so a new subpath export propagates here for free. That map also carries
 * the private `@act/*` namespace (the in-repo example apps — calculator /
 * server / client, not a published scope); no test imports those, but they
 * ride along so one map serves both tools. vitest discovers this root config
 * for sub-package invocations too (e.g. `pnpm -F @rotorsoft/act-pg exec
 * vitest run ...`), so resolution is CWD-independent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const root = import.meta.dirname;

// Derive vite aliases from the tsconfig path map. Each key becomes an
// anchored regex (so `@rotorsoft/act` doesn't prefix-match `@rotorsoft/act/x`)
// with `*` → a capture group; exact keys are ordered before wildcard keys so
// the specific mappings win.
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
    // Agent worktrees under .claude/worktrees hold full checkouts of the
    // repo; without this exclude, a bare `vitest run` discovers their
    // spec copies too — duplicated suites and contention on shared
    // resources (the docker postgres) make runs fail spuriously.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
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
      // 100% on every metric is the merge gate (CLAUDE.md); the enforced
      // thresholds must match the stated policy (#1112).
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
