#!/usr/bin/env node
/**
 * Every published lib must advertise **source** in the workspace and **build
 * output** on publish (issue #1676).
 *
 * The reason is resolution, not packaging. A package that advertises only its
 * `dist/` sends every workspace sibling — vitest, `tsc`, `node` — to build
 * output, so a `vitest` run from inside a package directory tested stale
 * `dist/` while passing green, because specs that import from `"vitest"`
 * explicitly do not need the `globals` the root config provides and so never
 * failed loudly. The root `vite.config.ts` papered over it with a
 * `resolve.alias` map, but vitest 5 does not find that config from a
 * sub-package cwd, so the alias map was absent exactly where it was needed.
 *
 * Pointing `exports` at `./src/*.ts` and moving the `dist` entries to
 * `publishConfig.exports` fixes it for every tool at once, with no
 * per-package config files: pnpm swaps the two at publish time, so the
 * artifact on npm is unchanged.
 *
 * That swap is the thing that can silently regress — a new package written
 * from an old template, or a well-meaning "fix" moving `dist` back to
 * `exports` — and a regression is invisible until someone trusts a green
 * suite that tested yesterday's build. Hence this check.
 *
 * Rules, per published lib (one with a `publishConfig`):
 *   1. every object-valued `exports` entry points into `./src/` and ends `.ts`
 *   2. each of those source files exists
 *   3. `publishConfig.exports` covers the same subpaths, pointing into `./dist/`
 *   4. no top-level `main` / `module` / `types` — those belong under
 *      `publishConfig` too, or they contradict `exports` locally
 *
 * A non-object entry (act-diagram's `./styles.css`) is a build artifact with
 * no source equivalent and is skipped by rules 1-2.
 *
 * Dependency-free; uses only `node:`.
 *
 *   node scripts/check-workspace-exports.mjs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const libs = join(root, "libs");
const problems = [];
let checked = 0;

for (const dir of readdirSync(libs).sort()) {
  const manifest_path = join(libs, dir, "package.json");
  if (!existsSync(manifest_path)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest_path, "utf8"));
  } catch {
    problems.push(`libs/${dir}/package.json is not valid JSON`);
    continue;
  }
  // Unpublished packages have nothing to swap.
  if (!pkg.publishConfig) continue;
  if (!pkg.exports || typeof pkg.exports !== "object") continue;
  checked++;

  const where = `libs/${dir}`;
  const published = pkg.publishConfig.exports;

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    // Rule 1-2: source-first, and the file is really there.
    if (entry && typeof entry === "object") {
      for (const [condition, target] of Object.entries(entry)) {
        if (typeof target !== "string") continue;
        if (!target.startsWith("./src/") || !target.endsWith(".ts")) {
          problems.push(
            `${where} exports["${subpath}"].${condition} is "${target}" — must point into ./src/ and end in .ts`
          );
          continue;
        }
        if (!existsSync(join(libs, dir, target.slice(2))))
          problems.push(
            `${where} exports["${subpath}"].${condition} points at "${target}", which does not exist`
          );
      }
    }

    // Rule 3: the published half covers the same subpath, on dist.
    const pub = published?.[subpath];
    if (pub === undefined) {
      problems.push(
        `${where} publishConfig.exports is missing "${subpath}" — the published package would not expose it`
      );
      continue;
    }
    const targets =
      typeof pub === "string"
        ? [pub]
        : Object.values(pub).filter((v) => typeof v === "string");
    for (const target of targets)
      if (!target.startsWith("./dist/"))
        problems.push(
          `${where} publishConfig.exports["${subpath}"] is "${target}" — must point into ./dist/`
        );
  }

  // Rule 4: no top-level build-output fields contradicting `exports`.
  for (const field of ["main", "module", "types", "typings"])
    if (pkg[field] !== undefined)
      problems.push(
        `${where} has a top-level "${field}" (${pkg[field]}) — move it under publishConfig so it does not contradict the source-first exports`
      );
}

if (problems.length === 0) {
  console.log(
    `workspace exports guard: ${checked} published package(s), all source-first with a dist publishConfig — OK.`
  );
  process.exit(0);
}

console.error("workspace exports guard FAILED.\n");
console.error(
  "Published libs must advertise source in the workspace and build output on\n" +
    "publish, so every tool resolves a workspace sibling to src/ (#1676):\n\n" +
    '  "exports":       { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } }\n' +
    '  "publishConfig": { "exports": { ".": { "types": "./dist/@types/index.d.ts",\n' +
    '                                         "import": "./dist/index.js",\n' +
    '                                         "require": "./dist/index.cjs" } } }\n\n' +
    "pnpm swaps the two at publish time, so the artifact on npm is unchanged.\n"
);
for (const p of problems) console.error(`  ${p}`);
console.error("");
process.exit(1);
