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
  kind_color,
  orange,
  pink,
  red,
  violet,
} from "./colors.js";
import {
  type ContractIndex,
  event_status,
  type IndexEntry,
} from "./contract-index.js";

const loc = (file?: string, line?: number): string => {
  if (!file) return "";
  return line ? `${file}:${line}` : file;
};

const file_note = (file?: string, line?: number): string => {
  const l = loc(file, line);
  return l ? `  ${dim(l)}` : "";
};

const kind_label = (kind: string): string => {
  const k = kind_color[kind as keyof typeof kind_color];
  return (k ?? dim)(kind.padEnd(10));
};

/** Format a "matches" list view (multiple search results). */
export function format_matches(query: string, matches: IndexEntry[]): string {
  if (matches.length === 0) return dim(`no matches for "${query}"`);
  const head = dim(`matches (${matches.length}) — type a number to pick:`);
  const width = String(matches.length).length;
  const lines = matches.map((m, i) => {
    const idx = dim(`[${String(i + 1).padStart(width)}]`);
    const where = loc(m.file, m.line);
    const q = m.qualifier ? dim(` (${m.qualifier})`) : "";
    const w = where ? `  ${dim(where)}` : "";
    return `  ${idx} ${kind_label(m.kind)} ${m.name}${q}${w}`;
  });
  return [head, ...lines].join("\n");
}

const find_actions_emitting = (
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

const find_reactions_for = (
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

const find_projections_for = (
  model: DomainModel,
  event_name: string
): Array<{ name: string; file?: string }> =>
  model.projections
    .filter((p) => p.handles.includes(event_name))
    .map((p) => ({ name: p.name, file: p.file }));

/** Detailed event view: schema, producers, consumers, deprecation. */
export function format_event(idx: ContractIndex, entry: IndexEntry): string {
  const model = idx.model;
  let schema: string | undefined;
  let owning_state: { name: string; file?: string } | undefined;
  for (const st of model.states) {
    const ev = st.events.find((e) => e.name === entry.name);
    if (ev) {
      schema = ev.schema;
      owning_state = { name: st.name, file: st.file };
      break;
    }
  }
  const file = entry.file ?? owning_state?.file;

  const status = event_status(entry.name, idx.all_event_names);
  const status_line =
    status.status === "active"
      ? green("active")
      : // `superseded_by` is always set on deprecated entries — see event_status.
        `${red("deprecated")} (superseded by ${orange(status.superseded_by as string)})`;

  const lines: string[] = [];
  lines.push(bold(orange(entry.name)));
  if (file) lines.push(`  in:      ${dim(loc(file, entry.line))}`);
  if (owning_state && owning_state.name !== entry.name)
    lines.push(`  on:      ${amber(owning_state.name)}`);
  lines.push(`  schema:  ${schema ?? dim("(not captured)")}`);
  lines.push(`  status:  ${status_line}`);

  const producers = find_actions_emitting(model, entry.name);
  if (producers.length > 0) {
    lines.push("  producers:");
    for (const p of producers) {
      lines.push(
        `    - ${pink(p.action)}  ${dim(`(on ${p.state})`)}${file_note(p.file, p.line)}`
      );
    }
  } else {
    lines.push(`  producers: ${dim("(none)")}`);
  }

  const reactions = find_reactions_for(model, entry.name);
  const projections = find_projections_for(model, entry.name);
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
        `    - ${slice}${fuchsia(r.handler)}${triggers}${file_note(r.file, r.line)}`
      );
    }
    for (const p of projections) {
      lines.push(`    - ${emerald(p.name)}${file_note(p.file)}`);
    }
  }

  return lines.join("\n");
}

export function format_action(idx: ContractIndex, entry: IndexEntry): string {
  const model = idx.model;
  const owner_name = entry.qualifier;
  let action:
    | { name: string; emits: string[]; invariants: string[]; line?: number }
    | undefined;
  let state_file: string | undefined;
  for (const st of model.states) {
    if (owner_name && st.name !== owner_name) continue;
    const a = st.actions.find((x) => x.name === entry.name);
    if (a) {
      action = a;
      state_file = st.file;
      break;
    }
  }
  const lines: string[] = [];
  lines.push(bold(pink(entry.name)));
  if (owner_name) lines.push(`  on:      ${amber(owner_name)}`);
  if (state_file)
    lines.push(
      `  in:      ${dim(loc(state_file, action?.line ?? entry.line))}`
    );
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

export function format_state(idx: ContractIndex, entry: IndexEntry): string {
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

export function format_slice(idx: ContractIndex, entry: IndexEntry): string {
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
        `    - ${orange(r.event)} → ${fuchsia(r.handlerName)}${triggers}${file_note(r.file, r.line)}`
      );
    }
  }
  return lines.join("\n");
}

export function format_projection(
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

export function format_reaction(idx: ContractIndex, entry: IndexEntry): string {
  const [slice_name, event_name] = (entry.qualifier ?? "::").split("::");
  const lines: string[] = [];
  const slice = slice_name && slice_name !== "*" ? violet(slice_name) : "";
  // Compact header: ReactionName (in SliceName) — the slice prefix gets
  // baked into the title so we don't burn a separate `in: <slice>` line.
  const header = slice
    ? `${bold(fuchsia(entry.name))} ${dim(`(in ${slice})`)}`
    : bold(fuchsia(entry.name));
  lines.push(header);
  if (event_name) lines.push(`  on:      ${orange(event_name)}`);
  if (entry.file) lines.push(`  in:      ${dim(loc(entry.file, entry.line))}`);

  // Find the reaction in the model to enrich with producer/dispatch info.
  const slice_reaction = idx.model.slices
    .find((s) => s.name === slice_name)
    ?.reactions.find(
      (r) => r.handlerName === entry.name && r.event === event_name
    );
  const orch_reaction = idx.model.reactions.find(
    (r) => r.handlerName === entry.name && r.event === event_name
  );
  const r = slice_reaction ?? orch_reaction;

  if (event_name) {
    const producers = find_actions_emitting(idx.model, event_name);
    if (producers.length > 0) {
      lines.push("  producers (of triggering event):");
      for (const p of producers) {
        lines.push(
          `    - action ${pink(p.action)} (state ${p.state})${file_note(p.file, p.line)}`
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
  event: format_event,
  action: format_action,
  state: format_state,
  slice: format_slice,
  projection: format_projection,
  reaction: format_reaction,
};

export function format_detail(idx: ContractIndex, entry: IndexEntry): string {
  const fmt = formatters[entry.kind];
  return fmt ? fmt(idx, entry) : "";
}

/** Header summary printed once at CLI startup. */
export function format_summary(idx: ContractIndex): string {
  const m = idx.model;
  const parts = [
    `${m.states.length} ${m.states.length === 1 ? "state" : "states"}`,
    `${m.slices.length} ${m.slices.length === 1 ? "slice" : "slices"}`,
    `${m.projections.length} ${
      m.projections.length === 1 ? "projection" : "projections"
    }`,
    `${idx.all_event_names.size} ${
      idx.all_event_names.size === 1 ? "event" : "events"
    }`,
  ];
  return dim(`loaded ${parts.join(", ")}`);
}
