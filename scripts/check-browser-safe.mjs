#!/usr/bin/env node
/**
 * Browser-safety check for the entry points client code imports.
 *
 * Some published subpaths are imported from a browser (`@rotorsoft/act-http/sse`
 * for `applyPatchMessage`), and one static import of `@rotorsoft/act` in the
 * same barrel pulls Node's `AsyncLocalStorage` into every client bundle.
 * This walks each entry's import graph, `@rotorsoft/*` builds and
 * `import("literal")` chunks included, and fails on any `node:` builtin or
 * bare Node module, on an imported zod, and when the files it reaches outgrow
 * the entry's budget (an inlined zod, from a build that forgot to keep it
 * external, is ~750 KB).
 *
 * Runs against `dist/`, so `pnpm build` must come first.
 *
 * Exits non-zero on any violation.
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * Built files a browser is expected to be able to load, with the import that
 * makes each one client-facing. Add an entry when a subpath starts being
 * documented for client use — not every published entry belongs here, only
 * the ones a bundler will follow.
 */
const BROWSER_ENTRIES = [
  {
    entry: "libs/act-http/dist/sse/index.js",
    why: "applyPatchMessage + wire types — see docs/docs/concepts/real-time.md",
    // Unminified bytes of every file it reaches: ~13.5 KB today, ~750 KB when
    // a build inlined zod (#2587).
    budget: 20_000,
  },
];

/** Packages a browser entry must not reach: the app ships its own copy. */
const SERVER_ONLY = ["zod"];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/** `import`/`export ... from` specifiers, plus `import("literal")`. */
const specifiers = (source) => {
  const out = [];
  const re = /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
  const bare = /(?:^|[\s;}])import\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) out.push(m[1]);
  for (const m of source.matchAll(bare)) out.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g))
    out.push(m[1]);
  return out;
};

/** Resolve a `@rotorsoft/*` specifier to its built entry file, if we ship it. */
const resolve_workspace = (spec) => {
  const m = /^@rotorsoft\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return undefined;
  const [, pkg, subpath] = m;
  const pkg_json = join(ROOT, "libs", pkg, "package.json");
  if (!existsSync(pkg_json)) return undefined;
  const manifest = JSON.parse(readFileSync(pkg_json, "utf8"));
  const key = subpath ? `./${subpath}` : ".";
  const entry =
    manifest.exports?.[key]?.import ?? (key === "." ? manifest.module : undefined);
  if (!entry) return undefined;
  return join(ROOT, "libs", pkg, entry);
};

const violations = [];

for (const { entry, why, budget } of BROWSER_ENTRIES) {
  const start = join(ROOT, entry);
  if (!existsSync(start)) {
    violations.push(`${entry} — not built; run \`pnpm build\` first`);
    continue;
  }
  const seen = new Set();
  /** @param {string} file @param {string[]} trail */
  const walk = (file, trail) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    // An inlined zod (~750 KB) blows the budget; an imported one is caught
    // below by name.
    bytes += Buffer.byteLength(source);
    for (const spec of specifiers(source)) {
      if (SERVER_ONLY.some((p) => spec === p || spec.startsWith(`${p}/`))) {
        violations.push(
          `${entry} reaches "${spec}"\n    via ${[...trail, spec].join(" → ")}\n    (${why})`
        );
        continue;
      }
      if (NODE_BUILTINS.has(spec)) {
        violations.push(
          `${entry} reaches Node builtin "${spec}"\n    via ${[...trail, spec].join(" → ")}\n    (${why})`
        );
        continue;
      }
      // Built imports name their file, `.js` included.
      if (spec.startsWith(".")) {
        walk(resolve(dirname(file), spec), [...trail, spec]);
        continue;
      }
      const workspace = resolve_workspace(spec);
      if (workspace && existsSync(workspace)) walk(workspace, [...trail, spec]);
    }
  };
  let bytes = 0;
  walk(start, [entry]);
  if (bytes > budget)
    violations.push(
      `${entry} reaches ${bytes} bytes, over its ${budget}-byte budget\n    (${why})`
    );
}

if (violations.length) {
  console.error(
    "Browser-facing entry points must not import Node APIs or server-only packages, or outgrow their budget:\n"
  );
  for (const v of violations) console.error(`  ✗ ${v}\n`);
  console.error(
    "Keep server-only code out of these entry points: a bundler follows every\n" +
      "import, dynamic ones included, into the browser build.\n"
  );
  process.exit(1);
}

console.log(
  `browser-safe: ${BROWSER_ENTRIES.length} entry point(s) carry no Node dependency or zod, within budget`
);
