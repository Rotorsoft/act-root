#!/usr/bin/env node
/**
 * Doc-snippet type-checker (issue #1033).
 *
 * Tangles every fenced ` ```ts ` / ` ```typescript ` block out of
 * `docs/docs/**\/*.{md,mdx}` into a gitignored temp dir (`docs/.snippets/`)
 * and type-checks the lot against the live `@rotorsoft/act` source via
 * `tsconfig.snippets.json`. This generalises the single-file
 * `docs/src/snippets/quickstart.ts` check (#966/#1019) to every inline
 * snippet, so shown code can't silently drift from the framework API.
 *
 * Opt-out convention: a block whose info string carries one of the skip
 * markers is copied to the page but NOT extracted for compilation. Use it
 * for intentionally-partial fragments (pseudo-code, `...` elisions,
 * shell-in-ts, deliberately-wrong "don't do this" examples):
 *
 *     ```ts no-check
 *     // a partial fragment that isn't meant to compile on its own
 *     state({ Foo: ... })
 *     ```
 *
 * Recognised markers (any one, case-insensitive): `no-check`, `nocheck`,
 * `no-typecheck`, `skip-check`.
 *
 * This script only extracts + reports; it shells out to `tsc` separately
 * (see the `check:snippets` npm script). Run `--list` to print the
 * extraction plan without writing anything.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(HERE, "..");
const SOURCE_DIR = join(DOCS_ROOT, "docs");
const OUT_DIR = join(DOCS_ROOT, ".snippets");
const SNIPPETS_TSCONFIG = join(DOCS_ROOT, "tsconfig.snippets.json");

const SKIP_MARKERS = ["no-check", "nocheck", "no-typecheck", "skip-check"];

/** Recursively collect *.md / *.mdx under a directory. */
async function collect_docs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect_docs(full)));
    else if (/\.mdx?$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

/**
 * Pull fenced ts blocks out of one markdown file. Returns
 * `{ index, info, code, skipped }` per block in document order.
 */
function extract_blocks(text) {
  const blocks = [];
  // ```<lang><meta>\n<code>\n``` — fence must start a line.
  const fence = /^```(ts|typescript)([^\n]*)\n([\s\S]*?)^```/gm;
  let match;
  let index = 0;
  while ((match = fence.exec(text)) !== null) {
    const info = match[2].trim();
    const code = match[3];
    const skipped = SKIP_MARKERS.some((m) =>
      new RegExp(`(^|\\s)${m}(\\s|$)`, "i").test(info)
    );
    blocks.push({ index: index++, info, code, skipped });
  }
  return blocks;
}

/** Sanitise a doc-relative path into a flat, unique filename stem. */
function stem_for(rel) {
  return rel.replace(/\.mdx?$/, "").replace(/[^a-zA-Z0-9]+/g, "_");
}

async function main() {
  const list_only = process.argv.includes("--list");
  const files = await collect_docs(SOURCE_DIR);

  let extracted = 0;
  let skipped = 0;
  const plan = [];

  if (!list_only) {
    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });
    // Mark the temp dir as ESM so `module: nodenext` treats each snippet as
    // an ES module — mirroring the root `"type": "module"` the rest of the
    // codebase (and docs/src/snippets/quickstart.ts) compiles under. Without
    // this, snippets resolve as CommonJS and top-level `await` is rejected.
    await writeFile(join(OUT_DIR, "package.json"), `{ "type": "module" }\n`);
  }

  for (const file of files) {
    const rel = relative(SOURCE_DIR, file);
    const text = await readFile(file, "utf8");
    const blocks = extract_blocks(text);
    for (const block of blocks) {
      if (block.skipped) {
        skipped++;
        continue;
      }
      const name = `${stem_for(rel)}__${block.index}.ts`;
      plan.push({ rel, index: block.index, name });
      if (!list_only) {
        // Header maps tsc diagnostics back to the source page; trailing
        // `export {}` forces module scope so same-named consts in
        // different snippets can't collide in a shared global namespace.
        const header = `// source: docs/${rel} (block #${block.index})\n`;
        await writeFile(
          join(OUT_DIR, name),
          `${header}${block.code}\nexport {};\n`
        );
      }
      extracted++;
    }
  }

  const verb = list_only ? "would extract" : "extracted";
  console.log(
    `doc snippets: ${verb} ${extracted}, skipped ${skipped} (markers: ${SKIP_MARKERS.join(", ")})`
  );
  if (list_only)
    for (const p of plan) console.log(`  ${p.name}  <-  docs/${p.rel} #${p.index}`);
}

/** Resolve the local `tsc` entry point without relying on `npx` network fetch. */
function resolve_tsc() {
  return createRequire(import.meta.url).resolve("typescript/bin/tsc");
}

function run_tsc() {
  return spawnSync(
    process.execPath,
    [resolve_tsc(), "--noEmit", "-p", SNIPPETS_TSCONFIG],
    { cwd: DOCS_ROOT, encoding: "utf8" }
  );
}

/**
 * Negative test: drop a deliberately-broken snippet into the harness and
 * confirm the type-check rejects it. Guards against the harness silently
 * passing everything (wrong tsconfig, swallowed exit code, etc.). Run in
 * CI right after the real gate.
 */
async function self_test() {
  await main(); // populate OUT_DIR + package.json the normal way
  const broken = join(OUT_DIR, "__selftest_broken__.ts");
  await writeFile(
    broken,
    [
      "// self-test: this MUST fail to type-check.",
      'import { act } from "@rotorsoft/act";',
      "const n: number = act().thisMethodDoesNotExist();",
      "export { n };",
      "",
    ].join("\n")
  );
  const result = run_tsc();
  await rm(broken, { force: true });
  const caught =
    result.status !== 0 && /__selftest_broken__/.test(result.stdout ?? "");
  if (!caught) {
    console.error(
      "self-test FAILED: harness did not reject a deliberately-broken snippet"
    );
    console.error(result.stdout);
    process.exit(1);
  }
  console.log("self-test ok: deliberately-broken snippet was rejected");
}

const run = process.argv.includes("--self-test") ? self_test : main;
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
