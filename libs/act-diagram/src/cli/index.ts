#!/usr/bin/env node
/**
 * `act` — interactive Act-app contracts explorer.
 *
 * Walks the project for TypeScript sources, feeds them through the
 * same `extract_model` parser the diagram uses, and lets you navigate
 * the domain model: category → entry → formatted detail → optional
 * jump-to-source in $EDITOR.
 *
 * Run with `pnpm act [dir]` from the repo root or
 * `pnpm -F @rotorsoft/act-diagram act [dir]` from anywhere.
 */
import { resolve } from "node:path";
import { extract_model } from "../client/lib/evaluate.js";
import { buildContractIndex, search } from "./contract-index.js";
import { formatDetail, formatMatches } from "./format.js";
import { formatJsonSchema } from "./json-schema.js";
import { loadProject } from "./load-project.js";
import { formatMarkdown } from "./markdown.js";
import { runInteractive } from "./repl.js";

export type CliArgs = {
  cwd?: string;
  help: boolean;
  version: boolean;
  maxFiles?: number;
  /** Non-interactive: print detail for the named entity and exit. */
  query?: string;
  /** Non-interactive: print the full registry as Markdown and exit. */
  markdown?: boolean;
  /** Non-interactive: print the full registry as JSON Schema and exit. */
  jsonSchema?: boolean;
};

export function parseArgs(argv: readonly string[]): CliArgs {
  let cwd: string | undefined;
  let help = false;
  let version = false;
  let maxFiles: number | undefined;
  let query: string | undefined;
  let markdown = false;
  let jsonSchema = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else if (a === "--cwd") cwd = argv[++i] ?? cwd;
    else if (a === "-q" || a === "--query") query = argv[++i] ?? query;
    else if (a === "-m" || a === "--markdown" || a === "--md") markdown = true;
    else if (a === "-j" || a === "--json-schema" || a === "--json")
      jsonSchema = true;
    else if (a === "--max-files") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) maxFiles = n;
    } else if (!a.startsWith("-")) cwd = a;
  }
  return { cwd, help, version, maxFiles, query, markdown, jsonSchema };
}

const USAGE = [
  "Usage: act [dir] [-q <name>] [-m | -j] [--cwd <dir>] [--max-files <n>] [--help] [--version]",
  "",
  "Interactive mode (default):",
  "  pnpm act                 # explore the current project",
  "  pnpm act packages/foo    # explore a specific package",
  "",
  "Non-interactive (scripts, CI):",
  "  pnpm act -q OrderPlaced       # print the detail for OrderPlaced and exit",
  "  pnpm act -m > EVENTS.md       # emit the full registry as Markdown",
  "  pnpm act -j > contracts.json  # emit per-event JSON Schema (machine-readable)",
  "",
  "In interactive mode you pick a category (events, actions, slices, …),",
  "then an entry, then view its neighborhood. From the detail view you",
  "can jump straight to the source file in $EDITOR. The top menu also",
  "offers an `Export` action that writes Markdown or JSON Schema to a",
  "file path you choose.",
].join("\n");

export type RunDeps = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  isTTY: boolean;
  argv: readonly string[];
  versionString: string;
  defaultDir?: string;
  /**
   * Override for the interactive flow. Defaults to `runInteractive`.
   * Exposed so tests can drive the non-`-q` code path without hanging
   * on real clack prompts.
   */
  runInteractive?: (
    idx: ReturnType<typeof buildContractIndex>,
    rootDir: string
  ) => Promise<void>;
};

export async function main(deps: RunDeps): Promise<number> {
  const args = parseArgs(deps.argv);
  if (args.help) {
    deps.output.write(USAGE + "\n");
    return 0;
  }
  if (args.version) {
    deps.output.write(deps.versionString + "\n");
    return 0;
  }

  const rootDir = resolve(args.cwd ?? deps.defaultDir ?? ".");
  const { files, truncated } = await loadProject(rootDir, {
    maxFiles: args.maxFiles,
  });
  if (files.length === 0) {
    deps.errorOutput.write(
      `act: no TypeScript source files found under ${rootDir}\n`
    );
    return 1;
  }
  if (truncated) {
    deps.errorOutput.write(
      "act: scan was truncated (file cap reached); some sources may be missing.\n"
    );
  }
  const { model, error } = extract_model(files);
  /* c8 ignore start — extract_model only sets `error` when every file
     fails to evaluate; hard to synthesize in unit tests. */
  if (error) {
    deps.errorOutput.write(`act: parse error — ${error}\n`);
  }
  /* c8 ignore stop */

  const idx = buildContractIndex(model);

  // Non-interactive Markdown registry: dump the full model and exit.
  // Pipe-friendly for `pnpm act -m > docs/EVENTS.md` and PR comments.
  if (args.markdown) {
    deps.output.write(`${formatMarkdown(idx)}\n`);
    return 0;
  }

  // Non-interactive JSON Schema export: machine-readable per-event
  // schemas plus the producer/consumer graph. Cross-service consumers
  // can `Ajv.compile()` the event schemas to validate payloads.
  if (args.jsonSchema) {
    deps.output.write(`${formatJsonSchema(idx)}\n`);
    return 0;
  }

  // Non-interactive scripted query: print the detail for the matching
  // entity and exit. Used by CI smoke tests and by power users in pipes.
  if (args.query) {
    const matches = search(idx, args.query);
    if (matches.length === 0) {
      deps.errorOutput.write(`act: no matches for "${args.query}"\n`);
      return 1;
    }
    const exact = matches.filter(
      (m) => m.name.toLowerCase() === args.query!.toLowerCase()
    );
    // Two entries with identical (kind, name, qualifier) describe the
    // same logical entity declared in different files (e.g. a `Counter`
    // state defined in two demo entrypoints). Collapse them so `-q`
    // surfaces a detail view instead of an ambiguity menu.
    const equivKey = (m: (typeof matches)[number]) =>
      `${m.kind}\x00${m.name}\x00${m.qualifier ?? ""}`;
    const uniqExact = Array.from(
      new Map(exact.map((m) => [equivKey(m), m])).values()
    );
    if (uniqExact.length === 1) {
      deps.output.write(formatDetail(idx, uniqExact[0]) + "\n");
      return 0;
    }
    const uniqMatches = Array.from(
      new Map(matches.map((m) => [equivKey(m), m])).values()
    );
    if (uniqMatches.length === 1) {
      deps.output.write(formatDetail(idx, uniqMatches[0]) + "\n");
      return 0;
    }
    deps.output.write(formatMatches(args.query, uniqMatches) + "\n");
    return 0;
  }

  // Default interactive flow ships in `repl.ts`; tests inject a stub
  // so the non-`-q` branch is exercised without the clack prompts.
  await (deps.runInteractive ?? runInteractive)(idx, rootDir);
  return 0;
}

/* c8 ignore start */
const isMain = (() => {
  try {
    if (typeof process === "undefined" || !process.argv?.[1]) return false;
    const entry = process.argv[1];
    return (
      import.meta.url === `file://${entry}` ||
      import.meta.url.endsWith(entry) ||
      entry.endsWith("/act") ||
      entry.endsWith("/act.js")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  main({
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    isTTY: !!process.stdout.isTTY,
    argv: process.argv.slice(2),
    versionString: "act (act-diagram)",
    defaultDir: process.env.INIT_CWD ?? process.cwd(),
  }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `act: fatal — ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(2);
    }
  );
}
/* c8 ignore stop */
