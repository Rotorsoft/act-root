#!/usr/bin/env node
/**
 * Browser-safety check for the entry points client code imports.
 *
 * Some published subpaths are imported from a browser: `@rotorsoft/act-http/sse`
 * carries `applyPatchMessage` and the SSE wire types, and the real-time guide
 * tells readers to import them in client code. That same subpath also exports
 * the server-side `BroadcastChannel`, and a barrel has no way to hand out one
 * half without loading the other.
 *
 * So a single static `import { log } from "@rotorsoft/act"` in the server half
 * is enough to pull the framework — and Node's `AsyncLocalStorage`, which it
 * constructs at module scope — into every browser bundle that touches the
 * subpath. That shipped for ten days before anyone ran the demo client
 * (#1423 added the import; nothing in CI builds a browser bundle).
 *
 * This walks the STATIC import graph of each entry below, following
 * `@rotorsoft/*` packages into their own builds, and fails on any `node:`
 * builtin or bare Node module. Dynamic `import()` is deliberately ignored: it
 * is the supported way to reach server-only code from a module that must stay
 * browser-safe, because a bundler leaves it as a separate chunk that a browser
 * never has to evaluate.
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
  },
];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/** Static `import`/`export ... from` specifiers. Dynamic `import()` is skipped. */
const specifiers = (source) => {
  const out = [];
  const re = /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
  const bare = /(?:^|[\s;}])import\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) out.push(m[1]);
  for (const m of source.matchAll(bare)) out.push(m[1]);
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

for (const { entry, why } of BROWSER_ENTRIES) {
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
    for (const spec of specifiers(source)) {
      if (NODE_BUILTINS.has(spec)) {
        violations.push(
          `${entry} reaches Node builtin "${spec}"\n    via ${[...trail, spec].join(" → ")}\n    (${why})`
        );
        continue;
      }
      if (spec.startsWith(".")) {
        const rel = resolve(dirname(file), spec);
        for (const candidate of [rel, `${rel}.js`, join(rel, "index.js")])
          if (existsSync(candidate) && !candidate.endsWith("/")) {
            walk(candidate, [...trail, spec]);
            break;
          }
        continue;
      }
      const workspace = resolve_workspace(spec);
      if (workspace && existsSync(workspace)) walk(workspace, [...trail, spec]);
    }
  };
  walk(start, [entry]);
}

if (violations.length) {
  console.error("Browser-facing entry points must not statically import Node APIs:\n");
  for (const v of violations) console.error(`  ✗ ${v}\n`);
  console.error(
    "Reach server-only code through a dynamic import() instead — a bundler\n" +
      "leaves it as a chunk the browser never evaluates.\n"
  );
  process.exit(1);
}

console.log(
  `browser-safe: ${BROWSER_ENTRIES.length} entry point(s) carry no static Node dependency`
);
