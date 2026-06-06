/**
 * Pretty-printers for the `act` CLI.
 *
 * Each detail view returns a multi-line string. Colors are applied
 * unconditionally — picocolors no-ops when stdout doesn't support color,
 * so test snapshots can drop ANSI escapes if needed.
 */

import type { DomainModel } from "../client/types/index.js";
import {
  amber,
  bold,
  dim,
  emerald,
  fuchsia,
  green,
  kindColor,
  orange,
  pink,
  red,
  violet,
} from "./colors.js";
import {
  type ContractIndex,
  eventStatus,
  type IndexEntry,
} from "./contract-index.js";

const loc = (file?: string, line?: number): string => {
  if (!file) return "";
  return line ? `${file}:${line}` : file;
};

const fileNote = (file?: string, line?: number): string => {
  const l = loc(file, line);
  return l ? `  ${dim(l)}` : "";
};

const kindLabel = (kind: string): string => {
  const k = kindColor[kind as keyof typeof kindColor];
  return (k ?? dim)(kind.padEnd(10));
};

/** Format a "matches" list view (multiple search results). */
export function formatMatches(query: string, matches: IndexEntry[]): string {
  if (matches.length === 0) return dim(`no matches for "${query}"`);
  const head = dim(`matches (${matches.length}) — type a number to pick:`);
  const width = String(matches.length).length;
  const lines = matches.map((m, i) => {
    const idx = dim(`[${String(i + 1).padStart(width)}]`);
    const where = loc(m.file, m.line);
    const q = m.qualifier ? dim(` (${m.qualifier})`) : "";
    const w = where ? `  ${dim(where)}` : "";
    return `  ${idx} ${kindLabel(m.kind)} ${m.name}${q}${w}`;
  });
  return [head, ...lines].join("\n");
}

const findActionsEmitting = (
  model: DomainModel,
  event_name: string
): Array<{
  state: string;
  action: string;
  file?: string;
  line?: number;
}> => {
  const out: Array<{
    state: string;
    action: string;
    file?: string;
    line?: number;
  }> = [];
  for (const st of model.states) {
    for (const act of st.actions) {
      if (act.emits.includes(event_name)) {
        out.push({
          state: st.name,
          action: act.name,
          file: st.file,
          line: act.line,
        });
      }
    }
  }
  return out;
};

const findReactionsFor = (
  model: DomainModel,
  event_name: string
): Array<{
  slice?: string;
  handler: string;
  dispatches: string[];
  file?: string;
  line?: number;
}> => {
  const out: Array<{
    slice?: string;
    handler: string;
    dispatches: string[];
    file?: string;
    line?: number;
  }> = [];
  for (const sl of model.slices) {
    for (const r of sl.reactions) {
      if (r.event === event_name) {
        out.push({
          slice: sl.name,
          handler: r.handlerName,
          dispatches: r.dispatches,
          file: r.file ?? sl.file,
          line: r.line,
        });
      }
    }
  }
  for (const r of model.reactions) {
    if (r.event === event_name) {
      out.push({
        handler: r.handlerName,
        dispatches: r.dispatches,
        file: r.file,
        line: r.line,
      });
    }
  }
  return out;
};

const findProjectionsFor = (
  model: DomainModel,
  event_name: string
): Array<{ name: string; file?: string }> =>
  model.projections
    .filter((p) => p.handles.includes(event_name))
    .map((p) => ({ name: p.name, file: p.file }));

/** Detailed event view: schema, producers, consumers, deprecation. */
export function formatEvent(idx: ContractIndex, entry: IndexEntry): string {
  const model = idx.model;
  let schema: string | undefined;
  let owningState: { name: string; file?: string } | undefined;
  for (const st of model.states) {
    const ev = st.events.find((e) => e.name === entry.name);
    if (ev) {
      schema = ev.schema;
      owningState = { name: st.name, file: st.file };
      break;
    }
  }
  const file = entry.file ?? owningState?.file;

  const status = eventStatus(entry.name, idx.allEventNames);
  const statusLine =
    status.status === "active"
      ? green("active")
      : // `supersededBy` is always set on deprecated entries — see eventStatus.
        `${red("deprecated")} (superseded by ${orange(status.supersededBy as string)})`;

  const lines: string[] = [];
  lines.push(bold(orange(entry.name)));
  if (file) lines.push(`  in:      ${dim(loc(file, entry.line))}`);
  if (owningState && owningState.name !== entry.name)
    lines.push(`  on:      ${amber(owningState.name)}`);
  lines.push(`  schema:  ${schema ?? dim("(not captured)")}`);
  lines.push(`  status:  ${statusLine}`);

  const producers = findActionsEmitting(model, entry.name);
  if (producers.length > 0) {
    lines.push("  producers:");
    for (const p of producers) {
      lines.push(
        `    - ${pink(p.action)}  ${dim(`(on ${p.state})`)}${fileNote(p.file, p.line)}`
      );
    }
  } else {
    lines.push(`  producers: ${dim("(none)")}`);
  }

  const reactions = findReactionsFor(model, entry.name);
  const projections = findProjectionsFor(model, entry.name);
  if (reactions.length === 0 && projections.length === 0) {
    lines.push(`  consumers: ${dim("(none)")}`);
  } else {
    lines.push("  consumers:");
    for (const r of reactions) {
      const slice = r.slice ? `${violet(r.slice)}${dim("::")}` : "";
      const triggers =
        r.dispatches.length > 0
          ? ` → ${r.dispatches.map((d) => pink(d)).join(", ")}`
          : "";
      lines.push(
        `    - ${slice}${fuchsia(r.handler)}${triggers}${fileNote(r.file, r.line)}`
      );
    }
    for (const p of projections) {
      lines.push(`    - ${emerald(p.name)}${fileNote(p.file)}`);
    }
  }

  return lines.join("\n");
}

export function formatAction(idx: ContractIndex, entry: IndexEntry): string {
  const model = idx.model;
  const ownerName = entry.qualifier;
  let action:
    | { name: string; emits: string[]; invariants: string[]; line?: number }
    | undefined;
  let stateFile: string | undefined;
  for (const st of model.states) {
    if (ownerName && st.name !== ownerName) continue;
    const a = st.actions.find((x) => x.name === entry.name);
    if (a) {
      action = a;
      stateFile = st.file;
      break;
    }
  }
  const lines: string[] = [];
  lines.push(bold(pink(entry.name)));
  if (ownerName) lines.push(`  on:      ${amber(ownerName)}`);
  if (stateFile)
    lines.push(`  in:      ${dim(loc(stateFile, action?.line ?? entry.line))}`);
  if (action) {
    if (action.invariants.length > 0) {
      lines.push("  invariants:");
      for (const inv of action.invariants) lines.push(`    - ${inv}`);
    }
    if (action.emits.length > 0) {
      lines.push("  emits:");
      for (const e of action.emits) lines.push(`    - ${orange(e)}`);
    } else {
      lines.push(`  emits:   ${dim("(none)")}`);
    }
  }
  return lines.join("\n");
}

export function formatState(idx: ContractIndex, entry: IndexEntry): string {
  const st = idx.model.states.find((s) => s.name === entry.name);
  const lines: string[] = [];
  lines.push(bold(amber(entry.name)));
  if (entry.file) lines.push(`  in:      ${dim(loc(entry.file, entry.line))}`);
  if (!st) return lines.join("\n");
  if (st.actions.length > 0) {
    lines.push("  actions:");
    for (const a of st.actions) {
      const emits = a.emits.length > 0 ? ` → ${a.emits.join(", ")}` : "";
      lines.push(`    - ${pink(a.name)}${emits}`);
    }
  }
  if (st.events.length > 0) {
    lines.push("  events:");
    for (const e of st.events) {
      const schema = e.schema ? `  ${dim(e.schema)}` : "";
      lines.push(`    - ${orange(e.name)}${schema}`);
    }
  }
  return lines.join("\n");
}

export function formatSlice(idx: ContractIndex, entry: IndexEntry): string {
  const sl = idx.model.slices.find((s) => s.name === entry.name);
  const lines: string[] = [];
  lines.push(bold(violet(entry.name)));
  if (entry.file) lines.push(`  in:      ${dim(loc(entry.file, entry.line))}`);
  if (!sl) return lines.join("\n");
  if (sl.error) lines.push(`  ${red("error: " + sl.error)}`);
  if (sl.states.length > 0) {
    lines.push("  states:");
    for (const s of sl.states) lines.push(`    - ${amber(s)}`);
  }
  if (sl.projections.length > 0) {
    lines.push("  projections:");
    for (const p of sl.projections) lines.push(`    - ${emerald(p)}`);
  }
  if (sl.reactions.length > 0) {
    lines.push("  reactions:");
    for (const r of sl.reactions) {
      const triggers =
        r.dispatches.length > 0
          ? ` → ${r.dispatches.map((d) => pink(d)).join(", ")}`
          : "";
      lines.push(
        `    - ${orange(r.event)} → ${fuchsia(r.handlerName)}${triggers}${fileNote(r.file, r.line)}`
      );
    }
  }
  return lines.join("\n");
}

export function formatProjection(
  idx: ContractIndex,
  entry: IndexEntry
): string {
  const pr = idx.model.projections.find((p) => p.name === entry.name);
  const lines: string[] = [];
  lines.push(bold(emerald(entry.name)));
  if (pr?.file) lines.push(`  in:      ${dim(loc(pr.file, pr.line))}`);
  if (!pr) return lines.join("\n");
  if (pr.handles.length > 0) {
    lines.push("  handles:");
    for (const h of pr.handles) lines.push(`    - ${orange(h)}`);
  }
  return lines.join("\n");
}

export function formatReaction(idx: ContractIndex, entry: IndexEntry): string {
  const [sliceName, event_name] = (entry.qualifier ?? "::").split("::");
  const lines: string[] = [];
  const slice = sliceName && sliceName !== "*" ? violet(sliceName) : "";
  // Compact header: ReactionName (in SliceName) — the slice prefix gets
  // baked into the title so we don't burn a separate `in: <slice>` line.
  const header = slice
    ? `${bold(fuchsia(entry.name))} ${dim(`(in ${slice})`)}`
    : bold(fuchsia(entry.name));
  lines.push(header);
  if (event_name) lines.push(`  on:      ${orange(event_name)}`);
  if (entry.file) lines.push(`  in:      ${dim(loc(entry.file, entry.line))}`);

  // Find the reaction in the model to enrich with producer/dispatch info.
  const sliceReaction = idx.model.slices
    .find((s) => s.name === sliceName)
    ?.reactions.find(
      (r) => r.handlerName === entry.name && r.event === event_name
    );
  const orchReaction = idx.model.reactions.find(
    (r) => r.handlerName === entry.name && r.event === event_name
  );
  const r = sliceReaction ?? orchReaction;

  if (event_name) {
    const producers = findActionsEmitting(idx.model, event_name);
    if (producers.length > 0) {
      lines.push("  producers (of triggering event):");
      for (const p of producers) {
        lines.push(
          `    - action ${pink(p.action)} (state ${p.state})${fileNote(p.file, p.line)}`
        );
      }
    }
  }
  if (r && r.dispatches.length > 0) {
    lines.push("  triggers:");
    for (const d of r.dispatches) lines.push(`    - action ${pink(d)}`);
  }
  return lines.join("\n");
}

export const formatters: Record<
  string,
  (idx: ContractIndex, entry: IndexEntry) => string
> = {
  event: formatEvent,
  action: formatAction,
  state: formatState,
  slice: formatSlice,
  projection: formatProjection,
  reaction: formatReaction,
};

export function formatDetail(idx: ContractIndex, entry: IndexEntry): string {
  const fmt = formatters[entry.kind];
  return fmt ? fmt(idx, entry) : "";
}

/** Header summary printed once at CLI startup. */
export function formatSummary(idx: ContractIndex): string {
  const m = idx.model;
  const parts = [
    `${m.states.length} ${m.states.length === 1 ? "state" : "states"}`,
    `${m.slices.length} ${m.slices.length === 1 ? "slice" : "slices"}`,
    `${m.projections.length} ${
      m.projections.length === 1 ? "projection" : "projections"
    }`,
    `${idx.allEventNames.size} ${
      idx.allEventNames.size === 1 ? "event" : "events"
    }`,
  ];
  return dim(`loaded ${parts.join(", ")}`);
}
