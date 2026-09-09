#!/usr/bin/env node
/**
 * Config-resolution check for package-level vitest runs (ticket #1652).
 *
 * Vitest 5 no longer walks up to the repo-root `vite.config.ts` when it is
 * invoked from a sub-package working directory. A package that runs vitest
 * without resolving that config loses two things: `globals` (so `describe`
 * is undefined and the suite fails loudly) and the `@rotorsoft/*` → source
 * alias map (so the suite silently exercises the package's stale built
 * `dist/` instead of the working tree).
 *
 * The second failure mode is the dangerous one, because it stays green. So
 * the rule is mechanical: a package that runs vitest must either name a
 * config on the command line, or hold a local `vitest.config.*` that leads
 * back to the root one.
 *
 * A dev-server `vite.config.ts` does NOT satisfy this. That is exactly the
 * shape act-diagram had — a react/tailwind build config with no test block
 * and no aliases, which vitest 5 happily picked up while resolving the
 * framework to `dist/`.
 *
 * Exits non-zero on any violation. Wire into CI alongside lint/test.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const WORKSPACES = ["libs", "packages"];
const LOCAL_CONFIGS = ["vitest.config.ts", "vitest.config.js"];
const REACHES_ROOT = /["'][./]*\.\.\/\.\.\/vite\.config(\.[jt]s)?["']/;

/** Package dirs that hold a package.json. */
function* packages() {
  for (const ws of WORKSPACES) {
    const dir = join(ROOT, ws);
    for (const name of readdirSync(dir)) {
      const pkg = join(dir, name, "package.json");
      try {
        if (statSync(pkg).isFile()) yield [`${ws}/${name}`, join(dir, name)];
      } catch {
        // not a package dir (stray file, removed workspace) — skip
      }
    }
  }
}

/** A local vitest config that leads back to the workspace root config. */
function reaches_root_config(dir) {
  for (const name of LOCAL_CONFIGS) {
    const path = join(dir, name);
    if (existsSync(path) && REACHES_ROOT.test(readFileSync(path, "utf8")))
      return true;
  }
  return false;
}

const violations = [];
for (const [label, dir] of packages()) {
  const script = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8")
  ).scripts?.test;
  // Only vitest scripts are in scope. A package with no test script runs
  // from the root invocation, which resolves the config correctly.
  if (!script || !/\bvitest\b/.test(script)) continue;
  if (script.includes("--config")) continue;
  if (reaches_root_config(dir)) continue;
  violations.push({ label, script });
}

if (violations.length) {
  console.error(
    "A package that runs vitest must resolve the root config (#1652).\n" +
      "Vitest 5 does not discover it from a sub-package cwd, so a bare run\n" +
      "loses `globals` and the @rotorsoft/* source aliases — and the alias\n" +
      "half fails GREEN, testing a stale dist/ instead of the working tree.\n"
  );
  for (const { label, script } of violations)
    console.error(`  ${label}: "test": "${script}"`);
  console.error(
    "\nFix: add a vitest.config.ts containing\n" +
      '  export { default } from "../../vite.config.js";\n' +
      "which also fixes a bare `vitest` run from that folder, or name a\n" +
      "config explicitly with --config."
  );
  process.exit(1);
}

console.log("check-vitest-config: every package vitest run resolves a config.");
