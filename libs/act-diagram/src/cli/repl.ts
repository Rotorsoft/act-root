/**
 * Interactive flow for the `act` CLI, powered by @clack/prompts.
 *
 * Loop: pick a category (or "search by name") → pick an entry → view
 * formatted detail → loop. Ctrl-C / `Quit` exits cleanly.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { intro, isCancel, log, outro, select, text } from "@clack/prompts";
import { dim, kindColor } from "./colors.js";
import {
  CATEGORY_KEYWORDS,
  type ContractIndex,
  type IndexEntry,
  type Kind,
  listByKind,
  search,
} from "./contract-index.js";
import { formatDetail, formatSummary } from "./format.js";
import { formatJsonSchema } from "./json-schema.js";
import { formatMarkdown } from "./markdown.js";
import { openInEditor, pickEditor } from "./open-editor.js";
import { enableVimKeys, type VimKeysHandle } from "./vim-keys.js";

/** Module-level handle so searchByName can pause/resume around text input. */
let vimKeys: VimKeysHandle | null = null;
/** Set when `/` is pressed in a select; the surrounding loop catches it. */
let searchRequested = false;

type CategoryChoice = Kind | "export";

/** Single-line nav legend appended to every select prompt. */
const NAV_LEGEND = dim("j/k or ↑/↓ move · enter pick · / search · esc/q back");

const KIND_LABELS: Record<Kind, string> = {
  event: "events",
  action: "actions",
  state: "states",
  slice: "slices",
  projection: "projections",
  reaction: "reactions",
};

const KIND_ORDER: Kind[] = [
  "event",
  "action",
  "state",
  "slice",
  "projection",
  "reaction",
];

const countByKind = (idx: ContractIndex, kind: Kind): number => {
  if (kind === "event") return idx.allEventNames.size;
  return idx.entries.filter((e) => e.kind === kind).length;
};

const labelEntry = (e: IndexEntry): string => {
  const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : "";
  const where = loc ? `  ${dim(loc)}` : "";
  const qual = e.qualifier ? dim(` (${e.qualifier})`) : "";
  // `e.kind` is a Kind union and `kindColor` has every Kind as a key,
  // so the lookup is total.
  const colored = kindColor[e.kind](e.name);
  return `${colored}${qual}${where}`;
};

async function pickFromList(
  idx: ContractIndex,
  rootDir: string,
  message: string,
  entries: IndexEntry[]
): Promise<void> {
  if (entries.length === 0) {
    log.warn("nothing to show.");
    return;
  }
  const pick = await select<IndexEntry>({
    message: `${message}  ${NAV_LEGEND}`,
    options: entries.map((e) => ({
      value: e,
      label: labelEntry(e),
      hint: e.kind,
    })),
    maxItems: 12,
  });
  if (isCancel(pick)) return;
  await showDetail(idx, rootDir, pick);
}

async function showDetail(
  idx: ContractIndex,
  rootDir: string,
  entry: IndexEntry
): Promise<void> {
  // log.message keeps our ANSI colors intact; `note()` would wrap each
  // line in a dim attribute that washes the kind colors out. The first
  // line of formatDetail is already the colored bold name, so no extra
  // title prefix.
  log.message(formatDetail(idx, entry));
  if (!entry.file) return;
  const editor = pickEditor(process.env);
  const action = await select<"open">({
    message: `now what?  ${NAV_LEGEND}`,
    options: [
      {
        value: "open" as const,
        label: `open in ${editor}`,
        hint: `${entry.file}${entry.line ? `:${entry.line}` : ""}`,
      },
    ],
  });
  if (isCancel(action)) return;
  const result = await openInEditor(entry.file, entry.line, { rootDir });
  if (!result.ok) log.warn(`editor exited: ${result.reason ?? "unknown"}`);
}

type ExportFormat = "markdown" | "json-schema";

const DEFAULT_PATHS: Record<ExportFormat, string> = {
  markdown: "act-contracts.md",
  "json-schema": "act-contracts.schema.json",
};

async function exportRegistry(
  idx: ContractIndex,
  rootDir: string
): Promise<void> {
  const format = await select<ExportFormat>({
    message: `Export as  ${NAV_LEGEND}`,
    options: [
      {
        value: "markdown" as const,
        label: "Markdown",
        hint: "human-readable registry, pipe to docs/EVENTS.md",
      },
      {
        value: "json-schema" as const,
        label: "JSON Schema",
        hint: "machine-readable; consumers can Ajv.compile() each event",
      },
    ],
  });
  if (isCancel(format)) return;

  vimKeys?.pause();
  const path = await text({
    message: `Save to (relative to ${dim(rootDir)})  ${dim("(esc to cancel)")}`,
    placeholder: DEFAULT_PATHS[format],
    initialValue: DEFAULT_PATHS[format],
  });
  vimKeys?.resume();
  if (isCancel(path) || !path || !path.trim()) return;

  const content =
    format === "markdown" ? formatMarkdown(idx) : formatJsonSchema(idx);
  const abs = resolve(rootDir, path.trim());
  try {
    await writeFile(abs, `${content}\n`, "utf8");
    log.success(`wrote ${abs}`);
  } catch (err) {
    log.error(
      /* c8 ignore next — the `String(err)` arm fires only on non-Error
         throws, which Node fs.writeFile doesn't produce. */
      `could not write ${abs}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function searchByName(
  idx: ContractIndex,
  rootDir: string
): Promise<void> {
  // Pause the vim-keys patch so j/k are typed as letters in the input
  // box. esc/q still cancel via clack's built-in handling (esc) or as
  // literal "q" if the user wants to search for that.
  vimKeys?.pause();
  const q = await text({
    message: `Partial name to search  ${dim("(esc to cancel)")}`,
    placeholder: "e.g. order, ticket, place",
  });
  vimKeys?.resume();
  if (isCancel(q) || !q || !q.trim()) return;
  const lower = q.trim().toLowerCase();
  const kind = CATEGORY_KEYWORDS[lower];
  if (kind) {
    await pickFromList(
      idx,
      rootDir,
      `${KIND_LABELS[kind]}`,
      listByKind(idx, kind)
    );
    return;
  }
  const matches = search(idx, q.trim(), 200);
  if (matches.length === 0) {
    log.warn(`no matches for "${q}"`);
    return;
  }
  await pickFromList(idx, rootDir, `matches for "${q}"`, matches);
}

export async function runInteractive(
  idx: ContractIndex,
  rootDir: string
): Promise<void> {
  // j/k → arrows, q → esc, / → request-search. Loops below catch the
  // searchRequested flag when clack cancels and jump to search.
  vimKeys = enableVimKeys(process.stdin);
  const unsub = vimKeys.onSlash(() => {
    searchRequested = true;
  });
  try {
    await driveInteractive(idx, rootDir);
  } finally {
    unsub();
    vimKeys.restore();
    vimKeys = null;
    searchRequested = false;
  }
}

async function driveInteractive(
  idx: ContractIndex,
  rootDir: string
): Promise<void> {
  intro("act — contracts explorer");
  log.message(formatSummary(idx));

  while (true) {
    // `/` anywhere in the flow cancels the active prompt and sets this
    // flag; checking at the top of the loop is enough for every screen
    // because each sub-flow returns control here.
    if (searchRequested) {
      searchRequested = false;
      await searchByName(idx, rootDir);
      continue;
    }
    const choice = await select<CategoryChoice>({
      message: `What do you want to inspect?  ${NAV_LEGEND}`,
      options: [
        ...KIND_ORDER.map((k) => ({
          value: k as CategoryChoice,
          label: kindColor[k](KIND_LABELS[k]),
          hint: `${countByKind(idx, k)}`,
        })),
        {
          value: "export" as const,
          label: "export",
          hint: "Markdown / JSON Schema",
        },
      ],
      maxItems: 10,
    });
    if (isCancel(choice)) {
      if (searchRequested) continue; // `/` was pressed — loop will pick it up
      outro("bye.");
      return;
    }
    if (choice === "export") {
      await exportRegistry(idx, rootDir);
      continue;
    }
    await pickFromList(
      idx,
      rootDir,
      `${KIND_LABELS[choice]}`,
      listByKind(idx, choice)
    );
  }
}
