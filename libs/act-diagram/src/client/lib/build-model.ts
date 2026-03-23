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

// ── Helpers ─────────────────────────────────────────────────────────

let _stateIdx = 0;

/** Convert a raw mock state to a StateNode. Returns error string on validation failure. */
function buildState(
  model: DomainModel,
  st: any
): { key: string; node: StateNode } | { error: string } {
  // Validate: detect corrupted imports (undefined schemas)
  const events = (st.events ?? {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(events)) {
    if (schema === undefined)
      return { error: `Event "${name}" has undefined schema` };
  }
  const rawActions = (st.actions ?? {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(rawActions)) {
    if (name.startsWith("__emits_")) continue;
    if (schema === undefined)
      return { error: `Action "${name}" has undefined schema` };
  }

  const domainName = st.name as string;
  const uniqueKey = `${domainName}:${_stateIdx++}`;

  const eventNodes: EventNode[] = [];
  for (const eventName of Object.keys(events)) {
    eventNodes.push({
      name: eventName,
      hasCustomPatch: st.patches?.has(eventName) ?? false,
    });
  }

  const actionNodes: ActionNode[] = [];
  for (const actionName of Object.keys(rawActions)) {
    if (actionName.startsWith("__emits_")) continue;
    const emits: string[] =
      (rawActions[`__emits_${actionName}`] as string[]) ?? [];
    const invariants = (st.given?.[actionName] ?? []).map(
      (inv: any) => inv.description ?? ""
    );
    actionNodes.push({ name: actionName, emits, invariants });
  }

  const node: StateNode = {
    name: domainName,
    varName: uniqueKey,
    events: eventNodes,
    actions: actionNodes,
    file: st._sourceFile as string | undefined,
  };
  model.states.push(node);
  st._modelKey = uniqueKey;
  return { key: uniqueKey, node };
}

function fixupReactions(
  reactions: ReactionNode[],
  files: FileTab[],
  sourceFile?: string
) {
  const fallbacks = reactions.filter((r) => r.handlerName.startsWith("on "));
  if (fallbacks.length === 0) return;
  const src = sourceFile
    ? files.find((f) => f.path === sourceFile)?.content
    : files.map((f) => f.content).join("\n");
  if (!src) return;
  const doRe =
    /\.on\(\s*["'`](\w+)["'`]\s*\)\s*\.do\(\s*(?:async\s+)?(?:function\s+(\w+)|(?:\w+\.)?(\w+))?/g;
  let dm;
  while ((dm = doRe.exec(src)) !== null) {
    const eventName = dm[1];
    const handlerName = dm[2] || dm[3];
    if (!handlerName) continue;
    const r = fallbacks.find(
      (r) => r.event === eventName && r.handlerName === `on ${eventName}`
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
  fileErrors: Map<string, string>;
};

// ── Bottom-up model builder ─────────────────────────────────────────

export function buildModel(
  result: ExecuteResult,
  files: FileTab[],
  expectedSlices: Map<string, string>
): { model: DomainModel; error?: string } {
  const rawStates = result.states.filter((s: any) => s && s._tag === "State");
  const rawSlices = result.slices.filter((s: any) => s && s._tag === "Slice");
  const rawProjections = result.projections.filter(
    (p: any) => p && p._tag === "Projection"
  );
  const rawActs = result.acts.filter((a: any) => a && a._tag === "Act");

  // Maps from raw mock ref → built result or error
  const stateByRef = new Map<
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
  for (const st of rawStates) {
    if (stateByRef.has(st)) continue;
    try {
      stateByRef.set(st, buildState(model, st));
    } catch (e) {
      stateByRef.set(st, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Also states from act builders
  for (const a of rawActs) {
    for (const st of a.states ?? []) {
      if (!st || st._tag !== "State" || stateByRef.has(st)) continue;
      try {
        stateByRef.set(st, buildState(model, st));
      } catch (e) {
        stateByRef.set(st, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // ── Step 2: Build each slice independently ────────────────────────
  const builtSliceNames = new Set<string>();

  for (const s of rawSlices) {
    const sliceName = (s._varName ?? "slice") as string;
    builtSliceNames.add(sliceName);

    try {
      try {
        fixupReactions(s.reactions as ReactionNode[], files);
      } catch {
        /* ignore fixup errors */
      }

      const sliceStateKeys: string[] = [];
      const errors: string[] = [];

      for (const st of s.states ?? []) {
        if (!st || typeof st !== "object") {
          // Find which file caused this — check all file errors
          const fileErr = [...result.fileErrors.values()][0];
          errors.push(fileErr ?? "Missing state (broken import)");
          continue;
        }
        const built = stateByRef.get(st);
        if (built) {
          if ("error" in built) {
            errors.push(built.error);
          } else {
            sliceStateKeys.push(built.key);
          }
        } else {
          // State not seen before — try building it now
          try {
            const result = buildState(model, st);
            stateByRef.set(st, result);
            if ("error" in result) {
              errors.push(result.error);
            } else {
              sliceStateKeys.push(result.key);
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            stateByRef.set(st, { error: msg });
            errors.push(msg);
          }
        }
      }

      const projNames: string[] = [];
      for (const p of s.projections ?? []) {
        if (p && p._tag === "Projection") projNames.push(p.target as string);
      }

      model.slices.push({
        name: sliceName,
        states: sliceStateKeys,
        stateVars: sliceStateKeys,
        projections: projNames,
        reactions: (s.reactions as ReactionNode[]) ?? [],
        file: s._sourceFile as string | undefined,
        error: errors.length > 0 ? errors.join("; ") : undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      model.slices.push({
        name: sliceName,
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
  for (const [name, filePath] of expectedSlices) {
    if (!builtSliceNames.has(name)) {
      model.slices.push({
        name,
        states: [],
        stateVars: [],
        projections: [],
        reactions: [],
        error:
          result.fileErrors.get(filePath) ??
          result.error ??
          "Failed to build slice",
        file: filePath,
      });
    }
  }

  // ── Step 3: Build projections ─────────────────────────────────────
  for (const p of rawProjections) {
    model.projections.push({
      name: p.target,
      varName: p.target,
      handles: p.handles,
    });
  }

  // ── Step 4: Compose act ───────────────────────────────────────────
  const statesInSlices = new Set(model.slices.flatMap((s) => s.states));
  const globalStateKeys = model.states
    .filter((s) => !statesInSlices.has(s.varName))
    .map((s) => s.varName);

  for (const a of rawActs) {
    try {
      fixupReactions(
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

    for (const r of (a.reactions as ReactionNode[]) ?? []) {
      model.reactions.push(r);
    }

    const entryPath = (a._sourceFile ?? "app.ts") as string;
    model.entries.push({
      path: entryPath,
      states: model.states,
      slices: model.slices,
      projections: model.projections,
      reactions: (a.reactions as ReactionNode[]) ?? [],
    });
  }

  // Global slice for standalone states/reactions
  if (globalStateKeys.length > 0 || model.reactions.length > 0) {
    model.slices.push({
      name: "global",
      states: globalStateKeys,
      stateVars: globalStateKeys,
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
