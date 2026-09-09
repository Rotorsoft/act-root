#!/usr/bin/env node
/**
 * Explicit-config check for package-level vitest scripts (ticket #1652).
 *
 * Vitest 5 no longer walks up to the repo-root `vite.config.ts` when it is
 * invoked from a sub-package working directory. A bare `vitest run` in a
 * package therefore loses two things the root config supplies: `globals`
 * (so `describe` is undefined and the suite fails loudly) and the
 * `@rotorsoft/*` → source alias map (so the suite silently exercises each
 * package's stale built `dist/` instead of the working tree).
 *
 * The second failure mode is the dangerous one: it stays green. So the rule
 * is mechanical rather than trust-based — a package `test` script that runs
 * vitest must say which config it wants.
 *
 * Exits non-zero on any violation. Wire into CI alongside lint/test.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const WORKSPACES = ["libs", "packages"];

/** Package dirs that hold a package.json. */
function* packages() {
  for (const ws of WORKSPACES) {
    const dir = join(ROOT, ws);
    for (const name of readdirSync(dir)) {
      const pkg = join(dir, name, "package.json");
      try {
        if (statSync(pkg).isFile()) yield [`${ws}/${name}`, pkg];
      } catch {
        // not a package dir (stray file, removed workspace) — skip
      }
    }
  }
}

const violations = [];
for (const [label, path] of packages()) {
  const script = JSON.parse(readFileSync(path, "utf8")).scripts?.test;
  // Only vitest scripts are in scope. A package with no test script runs
  // from the root invocation, which resolves the config correctly.
  if (!script || !/\bvitest\b/.test(script)) continue;
  if (!script.includes("--config"))
    violations.push({ label, script });
}

if (violations.length) {
  console.error(
    "Package test scripts must pass --config explicitly (#1652).\n" +
      "Vitest 5 does not discover the root vite.config.ts from a sub-package\n" +
      "cwd, so a bare `vitest run` loses `globals` and the @rotorsoft/* source\n" +
      "aliases — the latter silently tests a stale dist/ and stays green.\n"
  );
  for (const { label, script } of violations)
    console.error(`  ${label}: "test": "${script}"`);
  console.error(
    '\nFix: append `--config ../../vite.config.ts` (or point at the package\'s own config).'
  );
  process.exit(1);
}

console.log(
  "check-vitest-config: every package vitest script names its config."
);
