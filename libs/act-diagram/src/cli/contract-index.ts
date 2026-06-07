/**
 * Search index built from a parsed DomainModel.
 *
 * Walks the model once, materializes one IndexEntry per discoverable
 * symbol (events, actions, slices, projections, states, reactions),
 * and exposes a fuzzy lookup over them.
 *
 * Event status is derived from the `_v<digits>` convention documented
 * in CLAUDE.md and ACT-403: an event `Foo` is deprecated when any
 * `Foo_v<n>` with a higher version exists.
 */
import type { DomainModel } from "../client/types/index.js";

export type Kind =
  | "event"
  | "action"
  | "slice"
  | "projection"
  | "state"
  | "reaction";

export type IndexEntry = {
  kind: Kind;
  name: string;
  /** Disambiguator when names repeat across kinds or scopes. */
  qualifier?: string;
  file?: string;
  line?: number;
};

export type ContractIndex = {
  entries: IndexEntry[];
  model: DomainModel;
  /** All event names that appear anywhere in the model. */
  allEventNames: Set<string>;
};

/** Strip `_v<digits>` suffix and return logical (base, version). */
export function decomposeEventName(name: string): {
  base: string;
  version: number;
} {
  const m = name.match(/^(.+)_v(\d+)$/);
  if (m) return { base: m[1], version: Number.parseInt(m[2], 10) };
  return { base: name, version: 1 };
}

export type EventStatus = {
  status: "active" | "deprecated";
  supersededBy?: string;
};

/**
 * Return active/deprecated for an event name given the universe of
 * known event names. `Foo` is deprecated if any `Foo_v<n>` with a
 * higher version exists; the latest version wins.
 */
export function eventStatus(
  name: string,
  all_names: Iterable<string>
): EventStatus {
  const me = decomposeEventName(name);
  let bestVersion = me.version;
  let bestName: string | undefined;
  for (const other of all_names) {
    if (other === name) continue;
    const dec = decomposeEventName(other);
    if (dec.base === me.base && dec.version > bestVersion) {
      bestVersion = dec.version;
      bestName = other;
    }
  }
  return bestName
    ? { status: "deprecated", supersededBy: bestName }
    : { status: "active" };
}

export function buildContractIndex(model: DomainModel): ContractIndex {
  const entries: IndexEntry[] = [];
  const allEventNames = new Set<string>();

  for (const st of model.states) {
    entries.push({
      kind: "state",
      name: st.name,
      file: st.file,
      line: st.line,
    });
    for (const ev of st.events) {
      allEventNames.add(ev.name);
      entries.push({
        kind: "event",
        name: ev.name,
        qualifier: st.name,
        file: st.file,
        line: ev.line,
      });
    }
    for (const act of st.actions) {
      entries.push({
        kind: "action",
        name: act.name,
        qualifier: st.name,
        file: st.file,
        line: act.line,
      });
    }
  }
  for (const sl of model.slices) {
    entries.push({
      kind: "slice",
      name: sl.name,
      file: sl.file,
      line: sl.line,
    });
    for (const r of sl.reactions) {
      allEventNames.add(r.event);
      entries.push({
        kind: "reaction",
        name: r.handler_name,
        qualifier: `${sl.name}::${r.event}`,
        file: r.file ?? sl.file,
        line: r.line,
      });
    }
  }
  for (const pr of model.projections) {
    entries.push({
      kind: "projection",
      name: pr.name,
      file: pr.file,
      line: pr.line,
    });
    for (const ev of pr.handles) allEventNames.add(ev);
  }
  for (const r of model.reactions) {
    allEventNames.add(r.event);
    entries.push({
      kind: "reaction",
      name: r.handler_name,
      qualifier: `*::${r.event}`,
      file: r.file,
      line: r.line,
    });
  }

  return { entries, model, allEventNames };
}

/**
 * Map a category keyword (typed at the REPL prompt) to its kind.
 * Accepts singular and plural forms.
 */
export const CATEGORY_KEYWORDS: Record<string, Kind> = {
  event: "event",
  events: "event",
  action: "action",
  actions: "action",
  state: "state",
  states: "state",
  slice: "slice",
  slices: "slice",
  projection: "projection",
  projections: "projection",
  reaction: "reaction",
  reactions: "reaction",
};

/** Return every entry of a given kind, sorted by name. */
export function listByKind(idx: ContractIndex, kind: Kind): IndexEntry[] {
  return idx.entries
    .filter((e) => e.kind === kind)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fuzzy substring search across the index. Case-insensitive. Ranks
 * exact matches above prefix matches above generic substring matches.
 * Returns up to `limit` entries (default 20).
 */
export function search(
  idx: ContractIndex,
  query: string,
  limit = 20
): IndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ entry: IndexEntry; score: number }> = [];
  for (const entry of idx.entries) {
    const name = entry.name.toLowerCase();
    let score: number;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.entry.kind !== b.entry.kind)
      return a.entry.kind.localeCompare(b.entry.kind);
    return a.entry.name.localeCompare(b.entry.name);
  });
  return scored.slice(0, limit).map((s) => s.entry);
}
