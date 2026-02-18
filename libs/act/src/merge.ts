/**
 * @module merge
 * @category Builders
 *
 * Shared utilities for merging partial states and projections across builders.
 */
import { ZodObject, type ZodType } from "zod";
import type { Projection } from "./projection-builder.js";
import type { Schema, State } from "./types/index.js";

/**
 * Unwraps wrapper types (ZodOptional, ZodNullable, ZodDefault, ZodReadonly)
 * to find the base type name, e.g. `z.string().optional()` -> `"ZodString"`.
 */
export function baseTypeName(zodType: ZodType): string {
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
export function mergeSchemas(
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
export function mergeInits<S extends Schema>(
  existing: () => Readonly<S>,
  incoming: () => Readonly<S>
): () => Readonly<S> {
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
  if (states.has(state.name)) {
    // MERGE: same state name - combine events, actions, patches, handlers
    const existing = states.get(state.name)!;
    for (const name of Object.keys(state.actions)) {
      // Same schema reference means the same partial re-registered via another slice
      if (existing.actions[name] === state.actions[name]) continue;
      if (actions[name]) throw new Error(`Duplicate action "${name}"`);
    }
    for (const name of Object.keys(state.events)) {
      // Same schema reference means the same partial re-registered via another slice
      if (existing.events[name] === state.events[name]) continue;
      if (events[name]) throw new Error(`Duplicate event "${name}"`);
    }
    const merged = {
      ...existing,
      state: mergeSchemas(existing.state, state.state, state.name),
      init: mergeInits(existing.init, state.init),
      events: { ...existing.events, ...state.events },
      actions: { ...existing.actions, ...state.actions },
      patch: { ...existing.patch, ...state.patch },
      on: { ...existing.on, ...state.on },
      given: { ...existing.given, ...state.given },
      snap: state.snap || existing.snap,
    };
    states.set(state.name, merged);
    // Update ALL action->state pointers to the merged object
    for (const name of Object.keys(merged.actions)) {
      actions[name] = merged;
    }
    for (const name of Object.keys(state.events)) {
      if (events[name]) continue; // already registered, preserve reactions
      events[name] = {
        schema: state.events[name],
        reactions: new Map(),
      };
    }
  } else {
    // NEW: register state for the first time
    states.set(state.name, state);
    for (const name of Object.keys(state.actions)) {
      if (actions[name]) throw new Error(`Duplicate action "${name}"`);
      actions[name] = state;
    }
    for (const name of Object.keys(state.events)) {
      if (events[name]) throw new Error(`Duplicate event "${name}"`);
      events[name] = {
        schema: state.events[name],
        reactions: new Map(),
      };
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

// Resolves to nothing
export const _void_ = () => undefined;
