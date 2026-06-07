/**
 * Interactive flow for the `act` CLI, powered by @clack/prompts.
 *
 * Loop: pick a category (or "search by name") → pick an entry → view
 * formatted detail → loop. Ctrl-C / `Quit` exits cleanly.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { intro, isCancel, log, outro, select, text } from "@clack/prompts";
import { dim, kind_color } from "./colors.js";
import {
  CATEGORY_KEYWORDS,
  type ContractIndex,
  type IndexEntry,
  type Kind,
  list_by_kind,
  search,
} from "./contract-index.js";
import { format_detail, format_summary } from "./format.js";
import { format_json_schema } from "./json-schema.js";
import { format_markdown } from "./markdown.js";
import { open_in_editor, pick_editor } from "./open-editor.js";
import { enableVimKeys, type VimKeysHandle } from "./vim-keys.js";

/** Module-level handle so search_by_name can pause/resume around text input. */
let vim_keys: VimKeysHandle | null = null;
/** Set when `/` is pressed in a select; the surrounding loop catches it. */
let search_requested = false;

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

const count_by_kind = (idx: ContractIndex, kind: Kind): number => {
  if (kind === "event") return idx.all_event_names.size;
  return idx.entries.filter((e) => e.kind === kind).length;
};

const label_entry = (e: IndexEntry): string => {
  const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : "";
  const where = loc ? `  ${dim(loc)}` : "";
  const qual = e.qualifier ? dim(` (${e.qualifier})`) : "";
  // `e.kind` is a Kind union and `kind_color` has every Kind as a key,
  // so the lookup is total.
  const colored = kind_color[e.kind](e.name);
  return `${colored}${qual}${where}`;
};

async function pick_from_list(
  idx: ContractIndex,
  root_dir: string,
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
      label: label_entry(e),
      hint: e.kind,
    })),
    maxItems: 12,
  });
  if (isCancel(pick)) return;
  await show_detail(idx, root_dir, pick);
}

async function show_detail(
  idx: ContractIndex,
  root_dir: string,
  entry: IndexEntry
): Promise<void> {
  // log.message keeps our ANSI colors intact; `note()` would wrap each
  // line in a dim attribute that washes the kind colors out. The first
  // line of format_detail is already the colored bold name, so no extra
  // title prefix.
  log.message(format_detail(idx, entry));
  if (!entry.file) return;
  const editor = pick_editor(process.env);
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
  const result = await open_in_editor(entry.file, entry.line, { root_dir });
  if (!result.ok) log.warn(`editor exited: ${result.reason ?? "unknown"}`);
}

type ExportFormat = "markdown" | "json-schema";

const DEFAULT_PATHS: Record<ExportFormat, string> = {
  markdown: "act-contracts.md",
  "json-schema": "act-contracts.schema.json",
};

async function export_registry(
  idx: ContractIndex,
  root_dir: string
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

  vim_keys?.pause();
  const path = await text({
    message: `Save to (relative to ${dim(root_dir)})  ${dim("(esc to cancel)")}`,
    placeholder: DEFAULT_PATHS[format],
    initialValue: DEFAULT_PATHS[format],
  });
  vim_keys?.resume();
  if (isCancel(path) || !path || !path.trim()) return;

  const content =
    format === "markdown" ? format_markdown(idx) : format_json_schema(idx);
  const abs = resolve(root_dir, path.trim());
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

async function search_by_name(
  idx: ContractIndex,
  root_dir: string
): Promise<void> {
  // Pause the vim-keys patch so j/k are typed as letters in the input
  // box. esc/q still cancel via clack's built-in handling (esc) or as
  // literal "q" if the user wants to search for that.
  vim_keys?.pause();
  const q = await text({
    message: `Partial name to search  ${dim("(esc to cancel)")}`,
    placeholder: "e.g. order, ticket, place",
  });
  vim_keys?.resume();
  if (isCancel(q) || !q || !q.trim()) return;
  const lower = q.trim().toLowerCase();
  const kind = CATEGORY_KEYWORDS[lower];
  if (kind) {
    await pick_from_list(
      idx,
      root_dir,
      `${KIND_LABELS[kind]}`,
      list_by_kind(idx, kind)
    );
    return;
  }
  const matches = search(idx, q.trim(), 200);
  if (matches.length === 0) {
    log.warn(`no matches for "${q}"`);
    return;
  }
  await pick_from_list(idx, root_dir, `matches for "${q}"`, matches);
}

export async function run_interactive(
  idx: ContractIndex,
  root_dir: string
): Promise<void> {
  // j/k → arrows, q → esc, / → request-search. Loops below catch the
  // search_requested flag when clack cancels and jump to search.
  vim_keys = enableVimKeys(process.stdin);
  const unsub = vim_keys.on_slash(() => {
    search_requested = true;
  });
  try {
    await drive_interactive(idx, root_dir);
  } finally {
    unsub();
    vim_keys.restore();
    vim_keys = null;
    search_requested = false;
  }
}

async function drive_interactive(
  idx: ContractIndex,
  root_dir: string
): Promise<void> {
  intro("act — contracts explorer");
  log.message(format_summary(idx));

  while (true) {
    // `/` anywhere in the flow cancels the active prompt and sets this
    // flag; checking at the top of the loop is enough for every screen
    // because each sub-flow returns control here.
    if (search_requested) {
      search_requested = false;
      await search_by_name(idx, root_dir);
      continue;
    }
    const choice = await select<CategoryChoice>({
      message: `What do you want to inspect?  ${NAV_LEGEND}`,
      options: [
        ...KIND_ORDER.map((k) => ({
          value: k as CategoryChoice,
          label: kind_color[k](KIND_LABELS[k]),
          hint: `${count_by_kind(idx, k)}`,
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
      if (search_requested) continue; // `/` was pressed — loop will pick it up
      outro("bye.");
      return;
    }
    if (choice === "export") {
      await export_registry(idx, root_dir);
      continue;
    }
    await pick_from_list(
      idx,
      root_dir,
      `${KIND_LABELS[choice]}`,
      list_by_kind(idx, choice)
    );
  }
}
