#!/usr/bin/env node
/**
 * Writes the `@rotorsoft/*` `paths` in `tsconfig.workspace.json` from each
 * lib's `exports`, so tsc and vitest (which derives its aliases from them)
 * resolve every published subpath to source. A pattern takes one `*`, so
 * subpaths such as `@rotorsoft/act-http/sse` must be listed one by one.
 * act-diagram is skipped (its surface is React components); the bare
 * `@rotorsoft/*` and the example apps' `@act/*` stay wildcards.
 *
 * Usage:
 *   node scripts/derive-tsconfig-paths.mjs            # sync (rewrite paths)
 *   node scripts/derive-tsconfig-paths.mjs --write    # sync (rewrite paths)
 *   node scripts/derive-tsconfig-paths.mjs --check    # CI: fail on drift
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIBS_DIR = join(ROOT, "libs");
const TSCONFIG = join(ROOT, "tsconfig.workspace.json");

const UI_PACKAGES = new Set(["@rotorsoft/act-diagram"]);

// Wildcards kept around the generated entries.
const ACT_WILDCARD = ["./packages/*/src/index.ts"];
const ROTORSOFT_WILDCARD = ["./libs/*/src/index.ts"];

// Deterministic, locale-independent string order.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Build the expected `paths` map from every lib's `exports` field. */
function derive_paths() {
  const derived = [];
  for (const dir of readdirSync(LIBS_DIR).sort()) {
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(join(LIBS_DIR, dir, "package.json"), "utf8")
      );
    } catch {
      continue; // not a package dir (e.g. libs/tsconfig.base.json)
    }
    const name = manifest.name;
    if (!name?.startsWith("@rotorsoft/")) continue;
    if (UI_PACKAGES.has(name)) continue;
    for (const [subpath, mapping] of Object.entries(manifest.exports ?? {})) {
      const import_path =
        typeof mapping === "string" ? mapping : mapping?.import;
      if (!import_path?.endsWith(".js")) continue; // skip .css and friends
      // ./dist/api/index.js -> src/api/index.ts
      const rel = import_path
        .replace(/^\.\/dist\//, "")
        .replace(/\.js$/, ".ts");
      const key = subpath === "." ? name : `${name}${subpath.slice(1)}`;
      derived.push({
        key,
        dir,
        sub: subpath === "." ? "" : subpath.slice(2),
        target: `./libs/${dir}/src/${rel}`,
      });
    }
  }
  // Order: package dir asc, then bare-before-subpath, then subpath asc.
  derived.sort((a, b) => cmp(a.dir, b.dir) || cmp(a.sub, b.sub));

  const paths = { "@act/*": ACT_WILDCARD };
  for (const { key, target } of derived) paths[key] = [target];
  paths["@rotorsoft/*"] = ROTORSOFT_WILDCARD;
  return paths;
}

function read_actual() {
  const cfg = JSON.parse(readFileSync(TSCONFIG, "utf8"));
  return cfg.compilerOptions?.paths ?? {};
}

/** Semantic diff — order- and formatting-independent. */
function diff_paths(expected, actual) {
  const lines = [];
  const expected_keys = new Set(Object.keys(expected));
  const actual_keys = new Set(Object.keys(actual));
  for (const key of [...expected_keys].sort()) {
    if (!actual_keys.has(key)) {
      lines.push(`  missing  ${key} -> ${expected[key][0]}`);
    } else if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      lines.push(
        `  changed  ${key} -> ${expected[key][0]} (was ${JSON.stringify(
          actual[key]
        )})`
      );
    }
  }
  for (const key of [...actual_keys].sort()) {
    if (!expected_keys.has(key)) {
      lines.push(`  extra    ${key} (no matching export — remove it)`);
    }
  }
  return lines;
}

const check = process.argv.includes("--check");
const expected = derive_paths();

if (check) {
  const lines = diff_paths(expected, read_actual());
  if (lines.length > 0) {
    console.error(
      "tsconfig.workspace.json `paths` are out of sync with package `exports`:\n"
    );
    console.error(lines.join("\n"));
    console.error("\nRun `pnpm paths:sync` to regenerate, then commit.");
    process.exit(1);
  }
  console.log("tsconfig.workspace.json `paths` are in sync with package `exports`.");
} else {
  const cfg = JSON.parse(readFileSync(TSCONFIG, "utf8"));
  cfg.compilerOptions.paths = expected;
  writeFileSync(TSCONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(expected).length} \`paths\` entries to tsconfig.workspace.json.`
  );
}
