#!/usr/bin/env node
/**
 * Derive the `@rotorsoft/*` `paths` entries in `tsconfig.workspace.json`
 * from each lib package's `exports` map (ticket #1059, finishing #1036).
 *
 * The workspace path map is the single source of truth for both the
 * type-checker (`tsc --noEmit --project tsconfig.workspace.json`) and the
 * vitest alias map (`vite.config.ts` derives its aliases from these very
 * paths). Every published subpath export must have a matching `paths` entry
 * pointing at the package's `src` so both tools resolve workspace deps to
 * source instead of built `dist`. The catch-all `@rotorsoft/*` can only
 * express the bare specifier — TypeScript allows a single `*` per pattern,
 * so subpaths (`@rotorsoft/act-http/sse`, `@rotorsoft/act/test`) have to be
 * enumerated one by one. Hand-maintaining that enumeration is exactly what
 * let it drift (#1036); this generator owns it instead.
 *
 * Discovery mirrors `libs/act-tck/test/all-packages-stability.spec.ts`: walk
 * every `libs/<pkg>/package.json` whose name is under `@rotorsoft/`, and map
 * each `exports` subpath whose `import` target ends in `.js` to its `src`
 * entry (`./dist/api/index.js` -> `src/api/index.ts`). UI packages
 * (`act-diagram`) are skipped for the same reason the stability gate skips
 * them — their public surface is React components, and the `@rotorsoft/*`
 * catch-all still resolves the bare import to source.
 *
 * Two preserved, non-derivable wildcards bracket the generated block:
 *   - `@act/*` -> the in-repo example apps under `packages/*`, which declare
 *     no `exports` map at all, so there is nothing to enumerate and no
 *     subpaths to miss; the wildcard is correct and cannot rot.
 *   - `@rotorsoft/*` -> bare-specifier fallback for any lib (including the
 *     skipped UI package) not otherwise enumerated.
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

// Same exclusion as the workspace stability gate: act-diagram's public
// surface is React components, not a library entry point. Its bare import
// still resolves through the `@rotorsoft/*` catch-all below.
const UI_PACKAGES = new Set(["@rotorsoft/act-diagram"]);

// Non-derivable wildcards, preserved verbatim around the generated entries.
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
