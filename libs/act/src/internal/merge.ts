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
function base_type_name(zodType: ZodType): string {
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
function merge_schemas(
  existing: ZodType,
  incoming: ZodType,
  state_name: string
): ZodType {
  if (existing instanceof ZodObject && incoming instanceof ZodObject) {
    const existing_shape = existing.shape as Record<string, ZodType>;
    const incoming_shape = incoming.shape as Record<string, ZodType>;
    for (const key of Object.keys(incoming_shape)) {
      if (key in existing_shape) {
        const existing_base = base_type_name(existing_shape[key]);
        const incoming_base = base_type_name(incoming_shape[key]);
        if (existing_base !== incoming_base) {
          throw new Error(
            `Schema conflict in "${state_name}": key "${key}" has type "${existing_base}" but incoming partial declares "${incoming_base}"`
          );
        }
      }
    }
    return existing.extend(incoming_shape);
  }
  return existing;
}

/**
 * Merges two init functions by spreading both results together.
 * Each partial only provides its own defaults.
 */
function merge_inits<TState extends Schema>(
  existing: () => Readonly<TState>,
  incoming: () => Readonly<TState>
): () => Readonly<TState> {
  return () => ({ ...existing(), ...incoming() });
}

/**
 * Registers a state into a states map and action/event registries,
 * merging with existing same-name states (partial state support).
 */
export function register_state(
  state: State<any, any, any>,
  states: Map<string, State<any, any, any>>,
  actions: Record<string, any>,
  events: Record<string, any>
): void {
  const existing = states.get(state.name);
  if (existing) {
    merge_into_existing(state, existing, states, actions, events);
  } else {
    register_new_state(state, states, actions, events);
  }
}

/**
 * Registers a state for the first time. All action/event names must be unique
 * across the registry; collisions throw.
 */
function register_new_state(
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
function merge_into_existing(
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
  const merged_patch = merge_patches(existing.patch, state.patch, state.name);

  // 3. Build merged state
  const merged = {
    ...existing,
    state: merge_schemas(existing.state, state.state, state.name),
    init: merge_inits(existing.init, state.init),
    events: { ...existing.events, ...state.events },
    actions: { ...existing.actions, ...state.actions },
    patch: merged_patch,
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
function merge_patches(
  existing: Record<string, any>,
  incoming: Record<string, any>,
  state_name: string
): Record<string, any> {
  const merged = { ...existing };
  for (const name of Object.keys(incoming)) {
    const existing_p = existing[name];
    const incoming_p = incoming[name];
    if (!existing_p) {
      merged[name] = incoming_p;
      continue;
    }
    const existing_is_default = existing_p._passthrough;
    const incoming_is_default = incoming_p._passthrough;
    if (
      !existing_is_default &&
      !incoming_is_default &&
      existing_p !== incoming_p
    ) {
      throw new Error(
        `Duplicate custom patch for event "${name}" in state "${state_name}"`
      );
    }
    // Keep whichever is custom; if both passthrough or existing custom, keep existing
    if (existing_is_default && !incoming_is_default) {
      merged[name] = incoming_p;
    }
  }
  return merged;
}

/**
 * Merges reactions from one event register into another. The target is
 * assumed to already contain entries for every event name in the source
 * (e.g., act-builder's `.withSlice()` registers the slice's states first,
 * which seeds the target events). Reactions are keyed by `handler.name`;
 * two distinct handlers sharing a name on the same event throw rather than
 * silently overwriting (ACT-979). Re-merging the identical reaction object
 * is idempotent — mirrors {@link register_batch_handler}.
 */
export function merge_event_register(
  target: Record<string, { reactions: Map<string, unknown> }>,
  source: Record<string, { reactions: Map<string, unknown> }>
): void {
  for (const [event_name, source_reg] of Object.entries(source)) {
    const target_reg = target[event_name];
    if (!target_reg) continue;
    for (const [name, reaction] of source_reg.reactions) {
      const existing = target_reg.reactions.get(name);
      if (existing !== undefined && existing !== reaction)
        throw new Error(
          `Duplicate reaction "${name}" for event "${event_name}". ` +
            `Reaction handlers are keyed by function name; rename one of them.`
        );
      target_reg.reactions.set(name, reaction);
    }
  }
}

/**
 * Merges a projection's event schemas and reactions into an event registry,
 * deduplicating reaction names by appending "_p" on collision.
 */
export function merge_projection(
  proj: Projection<any>,
  events: Record<string, any>
): void {
  for (const event_name of Object.keys(proj.events)) {
    const proj_register = proj.events[event_name];
    const existing = events[event_name];
    if (!existing) {
      events[event_name] = {
        schema: proj_register.schema,
        reactions: new Map(proj_register.reactions),
      };
    } else {
      for (const [name, reaction] of proj_register.reactions) {
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
