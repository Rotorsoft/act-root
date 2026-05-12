/**
 * @module merge
 * @category Internal
 *
 * Shared utilities for merging partial states and projections across builders.
 * Lives in `internal/` because the symbols are consumed by the builder layer
 * (`act-builder`, `slice-builder`, `projection-builder`) but aren't part of
 * the public package surface.
 *
 * @internal
 */
import { ZodObject, type ZodType } from "zod";
import type { Projection } from "../builders/projection-builder.js";
import type { Schema, State } from "../types/index.js";

/**
 * Unwraps wrapper types (ZodOptional, ZodNullable, ZodDefault, ZodReadonly)
 * to find the base type name, e.g. `z.string().optional()` -> `"ZodString"`.
 */
function baseTypeName(zodType: ZodType): string {
  let t: any = zodType;
  while (typeof t.unwrap === "function") {
    t = t.unwrap();
  }
  return t.constructor.name;
}

/**
 * Merges two Zod schemas. If both are ZodObject instances, checks for
 * overlapping shape keys with incompatible base types (throws descriptive
 * error), then merges via `.extend()`. Falls back to keeping existing
 * schema if either is not a ZodObject.
 */
function mergeSchemas(
  existing: ZodType,
  incoming: ZodType,
  stateName: string
): ZodType {
  if (existing instanceof ZodObject && incoming instanceof ZodObject) {
    const existingShape = existing.shape as Record<string, ZodType>;
    const incomingShape = incoming.shape as Record<string, ZodType>;
    for (const key of Object.keys(incomingShape)) {
      if (key in existingShape) {
        const existingBase = baseTypeName(existingShape[key]);
        const incomingBase = baseTypeName(incomingShape[key]);
        if (existingBase !== incomingBase) {
          throw new Error(
            `Schema conflict in "${stateName}": key "${key}" has type "${existingBase}" but incoming partial declares "${incomingBase}"`
          );
        }
      }
    }
    return existing.extend(incomingShape);
  }
  return existing;
}

/**
 * Merges two init functions by spreading both results together.
 * Each partial only provides its own defaults.
 */
function mergeInits<TState extends Schema>(
  existing: () => Readonly<TState>,
  incoming: () => Readonly<TState>
): () => Readonly<TState> {
  return () => ({ ...existing(), ...incoming() });
}

/**
 * Registers a state into a states map and action/event registries,
 * merging with existing same-name states (partial state support).
 */
export function registerState(
  state: State<any, any, any>,
  states: Map<string, State<any, any, any>>,
  actions: Record<string, any>,
  events: Record<string, any>
): void {
  const existing = states.get(state.name);
  if (existing) {
    mergeIntoExisting(state, existing, states, actions, events);
  } else {
    registerNewState(state, states, actions, events);
  }
}

/**
 * Registers a state for the first time. All action/event names must be unique
 * across the registry; collisions throw.
 */
function registerNewState(
  state: State<any, any, any>,
  states: Map<string, State<any, any, any>>,
  actions: Record<string, any>,
  events: Record<string, any>
): void {
  states.set(state.name, state);
  for (const name of Object.keys(state.actions)) {
    if (actions[name]) throw new Error(`Duplicate action "${name}"`);
    actions[name] = state;
  }
  for (const name of Object.keys(state.events)) {
    if (events[name]) throw new Error(`Duplicate event "${name}"`);
    events[name] = { schema: state.events[name], reactions: new Map() };
  }
}

/**
 * Merges an incoming partial state into an existing same-name state and
 * updates the action/event registries. Splits into four phases:
 *   1. validate no cross-state action/event collisions
 *   2. merge per-event patches (one custom patch per event)
 *   3. build the merged state and replace it in the states map
 *   4. update action→state pointers and register new events
 */
function mergeIntoExisting(
  state: State<any, any, any>,
  existing: State<any, any, any>,
  states: Map<string, State<any, any, any>>,
  actions: Record<string, any>,
  events: Record<string, any>
): void {
  // 1. Validate no cross-state collisions for actions/events
  for (const name of Object.keys(state.actions)) {
    // Same schema reference means the same partial re-registered via another slice
    if (existing.actions[name] === state.actions[name]) continue;
    if (actions[name]) throw new Error(`Duplicate action "${name}"`);
  }
  for (const name of Object.keys(state.events)) {
    // Same schema reference means the same partial re-registered via another slice
    if (existing.events[name] === state.events[name]) continue;
    // Same event name registered in a same-name state partial with a
    // different Zod schema reference — silent contract drift that the
    // type system can't catch (structurally compatible shapes flow
    // through TS even when refinements/enums/literals disagree).
    // Reference identity is the rule: cross-slice event schemas must
    // come from a single shared instance.
    if (existing.events[name]) {
      throw new Error(
        `Event "${name}" in state "${state.name}" is declared with different Zod schemas across slices. ` +
          `Cross-slice event schemas must reference the same instance — ` +
          `extract a shared schema (e.g. \`export const ${name} = z.object({ ... })\` in a shared module) ` +
          `and import it in every slice that declares it.`
      );
    }
    if (events[name]) throw new Error(`Duplicate event "${name}"`);
  }

  // 2. Merge patches with custom-vs-passthrough resolution
  const mergedPatch = mergePatches(existing.patch, state.patch, state.name);

  // 3. Build merged state
  const merged = {
    ...existing,
    state: mergeSchemas(existing.state, state.state, state.name),
    init: mergeInits(existing.init, state.init),
    events: { ...existing.events, ...state.events },
    actions: { ...existing.actions, ...state.actions },
    patch: mergedPatch,
    on: { ...existing.on, ...state.on },
    given: { ...existing.given, ...state.given },
    snap:
      state.snap && existing.snap && state.snap !== existing.snap
        ? (() => {
            throw new Error(
              `Duplicate snap strategy for state "${state.name}"`
            );
          })()
        : state.snap || existing.snap,
  };
  states.set(state.name, merged);

  // 4. Update action→state pointers; register events not yet seen
  for (const name of Object.keys(merged.actions)) {
    actions[name] = merged;
  }
  for (const name of Object.keys(state.events)) {
    if (events[name]) continue; // already registered, preserve reactions
    events[name] = { schema: state.events[name], reactions: new Map() };
  }
}

/**
 * Merges two patch maps. Only one custom (non-passthrough) patch per event is
 * allowed; passthroughs always yield to custom reducers, and re-registering
 * the same custom patch (same reference, e.g. across slices) is a no-op.
 */
function mergePatches(
  existing: Record<string, any>,
  incoming: Record<string, any>,
  stateName: string
): Record<string, any> {
  const merged = { ...existing };
  for (const name of Object.keys(incoming)) {
    const existingP = existing[name];
    const incomingP = incoming[name];
    if (!existingP) {
      merged[name] = incomingP;
      continue;
    }
    const existingIsDefault = existingP._passthrough;
    const incomingIsDefault = incomingP._passthrough;
    if (!existingIsDefault && !incomingIsDefault && existingP !== incomingP) {
      throw new Error(
        `Duplicate custom patch for event "${name}" in state "${stateName}"`
      );
    }
    // Keep whichever is custom; if both passthrough or existing custom, keep existing
    if (existingIsDefault && !incomingIsDefault) {
      merged[name] = incomingP;
    }
  }
  return merged;
}

/**
 * Merges reactions from one event register into another. The target is
 * assumed to already contain entries for every event name in the source
 * (e.g., act-builder's `.withSlice()` registers the slice's states first,
 * which seeds the target events). Reaction names collide by `set()`
 * semantics — last write wins.
 */
export function mergeEventRegister(
  target: Record<string, { reactions: Map<string, unknown> }>,
  source: Record<string, { reactions: Map<string, unknown> }>
): void {
  for (const [eventName, sourceReg] of Object.entries(source)) {
    const targetReg = target[eventName];
    if (!targetReg) continue;
    for (const [name, reaction] of sourceReg.reactions) {
      targetReg.reactions.set(name, reaction);
    }
  }
}

/**
 * Merges a projection's event schemas and reactions into an event registry,
 * deduplicating reaction names by appending "_p" on collision.
 */
export function mergeProjection(
  proj: Projection<any>,
  events: Record<string, any>
): void {
  for (const eventName of Object.keys(proj.events)) {
    const projRegister = proj.events[eventName];
    const existing = events[eventName];
    if (!existing) {
      events[eventName] = {
        schema: projRegister.schema,
        reactions: new Map(projRegister.reactions),
      };
    } else {
      for (const [name, reaction] of projRegister.reactions) {
        let key = name;
        while (existing.reactions.has(key)) key = `${key}_p`;
        existing.reactions.set(key, reaction);
      }
    }
  }
}

// Resolves the event stream as source and target (default)
export const _this_ = ({ stream }: { stream: string }) => ({
  source: stream,
  target: stream,
});
