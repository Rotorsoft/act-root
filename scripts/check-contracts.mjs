#!/usr/bin/env node
// Checks docs/docs/architecture/behavior-contracts.md: every test a row
// cites must exist, by its exact name, in the file the row names.
//
// A citation is `file.ts` → "test name", "another name"; several are
// separated by ";". A quoted name with no file before it is looked up in
// every test file.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const doc = "docs/docs/architecture/behavior-contracts.md";
const skip = new Set(["node_modules", "dist", ".git", "coverage"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(spec|test)\.tsx?$|-tck\.ts$/.test(entry.name)) yield path;
  }
}

// Test names by repo-relative path, from it/test/describe calls.
const call =
  /\b(?:it|test|describe)(?:\.\w+(?:\([^)]*\))?)*\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/gs;
const names = new Map();
for (const dir of ["libs", "packages", "recipes"])
  for (const file of walk(join(root, dir))) {
    const found = new Set();
    for (const m of readFileSync(file, "utf8").matchAll(call))
      found.add(m[2].replace(/\\(.)/g, "$1"));
    names.set(relative(root, file), found);
  }

// The names in every file whose path ends with `cited` (or in all files).
const pool = (cited) => {
  const files = [...names.keys()].filter(
    (f) => !cited || f === cited || f.endsWith(`/${cited}`)
  );
  return files.length ? new Set(files.flatMap((f) => [...names.get(f)])) : undefined;
};

const errors = [];
const lines = readFileSync(join(root, doc), "utf8").split("\n");
lines.forEach((line, i) => {
  if (!line.startsWith("|") || /^\|\s*(-|Claim\b)/.test(line)) return;
  const cells = line.split(/(?<!\\)\|/);
  const cited = cells[cells.length - 2] ?? "";
  if (cited.includes("…")) errors.push(`${i + 1}: truncated test name (…)`);
  for (const part of cited.split(";")) {
    const file = part.match(/`([\w./-]+\.tsx?)`/)?.[1];
    const known = pool(file);
    if (!known) {
      errors.push(`${i + 1}: no test file named ${file}`);
      continue;
    }
    for (const [, name] of part.matchAll(/"([^"]+)"/g))
      if (!known.has(name))
        errors.push(`${i + 1}: ${file ?? "any test file"} has no test "${name}"`);
  }
});

if (errors.length) {
  console.error(`${doc}: ${errors.length} broken citation(s)`);
  for (const e of errors) console.error(`  line ${e}`);
  process.exit(1);
}
console.log(`${doc}: every cited test exists`);
