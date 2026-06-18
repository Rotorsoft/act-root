/**
 * Bottom-up model builder: inventory → states → slices → act
 *
 * 1. Scan source for all state/slice/projection/act declarations (inventory)
 * 2. Try to build each item independently from the raw mock results
 * 3. Always show every item — with diagram on success, error on failure
 */
import type {
  ActionNode,
  ActNode,
  DomainModel,
  EventNode,
  FileTab,
  ReactionNode,
  StateNode,
} from "../types/index.js";
import {
  extract_identifier_assignments,
  extract_schemas_from_source,
} from "./schema-extract.js";

// ── Helpers ─────────────────────────────────────────────────────────

let _stateIdx = 0;

/** Convert a raw mock state to a StateNode. Returns error string on validation failure. */
function build_state(
  model: DomainModel,
  st: any
): { key: string; node: StateNode } | { error: string } {
  // Validate: detect corrupted imports (undefined schemas)
  const events = (st.events ?? {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(events)) {
    if (schema === undefined)
      return { error: `Event "${name}" has undefined schema` };
  }
  const raw_actions = (st.actions ?? {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(raw_actions)) {
    if (name.startsWith("__emits_")) continue;
    if (schema === undefined)
      return { error: `Action "${name}" has undefined schema` };
  }

  const domain_name = st.name as string;
  const unique_key = `${domain_name}:${_stateIdx++}`;

  const event_nodes: EventNode[] = [];
  for (const event_name of Object.keys(events)) {
    event_nodes.push({
      name: event_name,
      hasCustomPatch: st.patches?.has(event_name) ?? false,
      // Stash the runtime Zod schema so the JSON Schema exporter can
      // call `z.toJSONSchema(zod)` later without re-running the parser.
      zod: events[event_name],
    });
  }

  const action_nodes: ActionNode[] = [];
  for (const action_name of Object.keys(raw_actions)) {
    if (action_name.startsWith("__emits_")) continue;
    const emits: string[] =
      (raw_actions[`__emits_${action_name}`] as string[]) ?? [];
    const invariants = (st.given?.[action_name] ?? []).map(
      (inv: any) => inv.description ?? ""
    );
    action_nodes.push({ name: action_name, emits, invariants });
  }

  const node: StateNode = {
    name: domain_name,
    varName: unique_key,
    events: event_nodes,
    actions: action_nodes,
    file: st._sourceFile as string | undefined,
  };
  model.states.push(node);
  st._modelKey = unique_key;
  return { key: unique_key, node };
}

function fixup_reactions(
  reactions: ReactionNode[],
  files: FileTab[],
  source_file?: string
) {
  const fallbacks = reactions.filter((r) => r.handlerName.startsWith("on "));
  if (fallbacks.length === 0) return;
  const src = source_file
    ? files.find((f) => f.path === source_file)?.content
    : files.map((f) => f.content).join("\n");
  if (!src) return;
  const do_re =
    /\.on\(\s*["'`](\w+)["'`]\s*\)\s*\.do\(\s*(?:async\s+)?(?:function\s+(\w+)|(?:\w+\.)?(\w+))?/g;
  let dm: RegExpExecArray | null;
  while ((dm = do_re.exec(src)) !== null) {
    const event_name = dm[1];
    const handlerName = dm[2] || dm[3];
    if (!handlerName) continue;
    const r = fallbacks.find(
      (r) => r.event === event_name && r.handlerName === `on ${event_name}`
    );
    if (r) r.handlerName = handlerName;
  }
}

// ── Types ───────────────────────────────────────────────────────────

export type ExecuteResult = {
  states: any[];
  slices: any[];
  projections: any[];
  acts: any[];
  error?: string;
  file_errors: Map<string, string>;
};

// ── Bottom-up model builder ─────────────────────────────────────────

export function build_model(
  result: ExecuteResult,
  files: FileTab[],
  expected_slices: Map<string, string>
): { model: DomainModel; error?: string } {
  const raw_states = result.states.filter((s: any) => s && s._tag === "State");
  const raw_slices = result.slices.filter((s: any) => s && s._tag === "Slice");
  const raw_projections = result.projections.filter(
    (p: any) => p && p._tag === "Projection"
  );
  const raw_acts = result.acts.filter((a: any) => a && a._tag === "Act");

  // Maps from raw mock ref → built result or error
  const state_by_ref = new Map<
    any,
    { key: string; node: StateNode } | { error: string }
  >();

  const model: DomainModel = {
    entries: [],
    states: [],
    slices: [],
    projections: [],
    reactions: [],
  };

  // ── Step 1: Build each state independently ────────────────────────
  for (const st of raw_states) {
    if (state_by_ref.has(st)) continue;
    try {
      state_by_ref.set(st, build_state(model, st));
    } catch (e) {
      state_by_ref.set(st, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Also states from act builders
  for (const a of raw_acts) {
    for (const st of a.states ?? []) {
      if (st?._tag !== "State" || state_by_ref.has(st)) continue;
      try {
        state_by_ref.set(st, build_state(model, st));
      } catch (e) {
        state_by_ref.set(st, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // ── Step 2: Build each slice independently ────────────────────────
  const built_slice_names = new Set<string>();

  for (const s of raw_slices) {
    const slice_name = (s._varName ?? "slice") as string;
    built_slice_names.add(slice_name);

    try {
      try {
        fixup_reactions(s.reactions as ReactionNode[], files);
      } catch {
        /* ignore fixup errors */
      }

      const slice_state_keys: string[] = [];
      const errors: string[] = [];

      for (const st of s.states ?? []) {
        if (!st || typeof st !== "object") {
          // Find which file caused this — check all file errors
          const fileErr = [...result.file_errors.values()][0];
          errors.push(fileErr ?? "Missing state (broken import)");
          continue;
        }
        const built = state_by_ref.get(st);
        if (built) {
          if ("error" in built) {
            errors.push(built.error);
          } else {
            slice_state_keys.push(built.key);
          }
        } else {
          // State not seen before — try building it now
          try {
            const result = build_state(model, st);
            state_by_ref.set(st, result);
            if ("error" in result) {
              errors.push(result.error);
            } else {
              slice_state_keys.push(result.key);
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            state_by_ref.set(st, { error: msg });
            errors.push(msg);
          }
        }
      }

      const proj_names: string[] = [];
      for (const p of s.projections ?? []) {
        if (p && p._tag === "Projection") proj_names.push(p.target as string);
      }

      const slice_file = s._sourceFile as string | undefined;
      model.slices.push({
        name: slice_name,
        states: slice_state_keys,
        stateVars: slice_state_keys,
        projections: proj_names,
        reactions: ((s.reactions as ReactionNode[]) ?? []).map((r) => ({
          ...r,
          file: r.file ?? slice_file,
        })),
        file: slice_file,
        error: errors.length > 0 ? errors.join("; ") : undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      model.slices.push({
        name: slice_name,
        states: [],
        stateVars: [],
        projections: [],
        reactions: [],
        error: msg,
        file: s._sourceFile as string | undefined,
      });
    }
  }

  // Always show expected slices that weren't built (from inventory)
  for (const [name, file_path] of expected_slices) {
    if (!built_slice_names.has(name)) {
      model.slices.push({
        name,
        states: [],
        stateVars: [],
        projections: [],
        reactions: [],
        error:
          result.file_errors.get(file_path) ??
          result.error ??
          "Failed to build slice",
        file: file_path,
      });
    }
  }

  // ── Step 2b: Capture best-effort Zod schema text per event ────────
  // Re-scan each state's source file for `.emits({...})` and slice out
  // the value expression for every known event name. The captured text
  // feeds both the act-contracts CLI and the diagram tooltips.
  //
  // Build a cross-file identifier map first so `.emits({ TicketOpened })`
  // resolves to the `export const TicketOpened = z.object(...)` that
  // lives in another module. First definition wins on collision — Act
  // codebases don't reassign event-schema identifiers.
  const source_by_path = new Map<string, string>();
  const external_idents = new Map<string, string>();
  for (const f of files) {
    source_by_path.set(f.path, f.content);
    for (const [ident, expr] of extract_identifier_assignments(f.content)) {
      if (!external_idents.has(ident)) external_idents.set(ident, expr);
    }
  }
  for (const st_node of model.states) {
    if (!st_node.file) continue;
    // `st_node.file` came from `_sourceFile`, which was set during file
    // evaluation — so it's always present in `files`. The `!` and
    // v8-ignore acknowledge the type-level optionality without paying
    // for an unreachable branch.
    /* v8 ignore next */
    const src = source_by_path.get(st_node.file)!;
    const names = new Set(st_node.events.map((e) => e.name));
    if (names.size === 0) continue;
    const schemas = extract_schemas_from_source(src, names, external_idents);
    for (const ev of st_node.events) {
      // Set unconditionally — `undefined` is a valid value for the
      // optional schema field and matches the "not captured" state.
      ev.schema = schemas.get(ev.name);
    }
  }

  // ── Step 3: Build projections ─────────────────────────────────────
  for (const p of raw_projections) {
    model.projections.push({
      name: p.target,
      varName: p.target,
      handles: p.handles,
      file: p._sourceFile as string | undefined,
    });
  }

  // ── Step 4: Compose act ───────────────────────────────────────────
  const states_in_slices = new Set(model.slices.flatMap((s) => s.states));
  const global_state_keys = model.states
    .filter((s) => !states_in_slices.has(s.varName))
    .map((s) => s.varName);

  for (const a of raw_acts) {
    try {
      fixup_reactions(
        (a.reactions as ReactionNode[]) ?? [],
        files,
        a._sourceFile as string | undefined
      );
    } catch {
      /* ignore */
    }

    model.orchestrator = {
      slices: model.slices.map((s) => s.name),
      projections: model.projections.map((p) => p.name),
      states: model.states.map((s) => s.name),
    } as ActNode;

    const act_file = a._sourceFile as string | undefined;
    for (const r of (a.reactions as ReactionNode[]) ?? []) {
      model.reactions.push({ ...r, file: r.file ?? act_file });
    }

    const entry_path = (a._sourceFile ?? "app.ts") as string;

    // Filter to items owned by this act builder
    const act_slice_names = new Set<string>(
      ((a.slices as any[]) ?? [])
        .filter((s: any) => s != null)
        .map((s: any) => s._varName ?? "")
        .filter(Boolean)
    );
    // Also include error placeholder slices from files referenced by this act
    for (const sl of model.slices) {
      if (sl.error && !act_slice_names.has(sl.name)) {
        // Check if this act's source file references this slice name
        const act_src = files.find((f) => f.path === entry_path)?.content ?? "";
        if (act_src.includes(sl.name)) {
          act_slice_names.add(sl.name);
        }
      }
    }

    const entry_slices = model.slices.filter((s) =>
      act_slice_names.has(s.name)
    );
    const slice_state_keys = new Set(entry_slices.flatMap((s) => s.states));

    const act_state_keys = new Set<string>();
    for (const s of (a.states as any[]) ?? []) {
      try {
        if (s && s._tag === "State") {
          act_state_keys.add((s._modelKey ?? s.name) as string);
        }
      } catch {
        /* skip corrupt state */
      }
    }
    const all_state_keys = new Set([...act_state_keys, ...slice_state_keys]);

    const act_proj_names = new Set<string>(
      ((a.projections as any[]) ?? [])
        .filter((p: any) => p && p._tag === "Projection")
        .map((p: any) => p.target as string)
    );
    // Include projections embedded in slices
    for (const sl of entry_slices) {
      for (const pn of sl.projections) act_proj_names.add(pn);
    }

    model.entries.push({
      path: entry_path,
      states: model.states.filter((s) => all_state_keys.has(s.varName)),
      slices: entry_slices,
      projections: model.projections.filter((p) => act_proj_names.has(p.name)),
      reactions: (a.reactions as ReactionNode[]) ?? [],
    });
  }

  // Global slice for standalone states/reactions
  if (global_state_keys.length > 0 || model.reactions.length > 0) {
    model.slices.push({
      name: "global",
      states: global_state_keys,
      stateVars: global_state_keys,
      projections: model.projections.map((p) => p.name),
      reactions: model.reactions,
    });
  }

  // Fallback entry if no act() found
  if (
    model.entries.length === 0 &&
    (model.states.length > 0 || model.slices.length > 0)
  ) {
    model.entries.push({
      path: "app",
      states: model.states,
      slices: model.slices,
      projections: model.projections,
      reactions: model.reactions,
    });
  }

  if (result.error && model.states.length === 0 && model.slices.length === 0) {
    return { model, error: result.error };
  }
  return { model };
}
