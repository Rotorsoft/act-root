/**
 * @module build-classify
 * @category Internal
 *
 * Build-time classification of the registry + state map. The Act constructor
 * needs four pre-computed inputs to wire its runtime subsystems:
 *
 * - `static_targets`     — known-up-front reaction targets (statics get
 *                         subscribed once at init; dynamics scan per event)
 * - `has_dynamic_resolvers` — short-circuit flag for `correlate()`
 * - `reactive_events`    — event names with at least one reaction (drives
 *                         the drain skip-flag in `do()` and `reset()`)
 * - `event_to_state`      — event-name → owning state, for `close({restart})`
 *                         seed loading in multi-state apps
 *
 * Pure function — single pass over events + states, fully testable without
 * instantiating Act.
 *
 * @internal
 */

import type {
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  State,
} from "../types/index.js";
import type { StaticTarget } from "./correlate-cycle.js";

/**
 * Classification result. Returned by {@link classify_registry}; consumed
 * piecewise by Act's constructor.
 *
 * @internal
 */
/**
 * Sentinel for "any reaction on this event has a dynamic resolver, so
 * the lane is opaque until correlate runs the function — arm every
 * controller." A Symbol rather than a string literal so it can't
 * collide with a user-declared lane named `"all"`.
 *
 * @internal
 */
export const ALL_LANES: unique symbol = Symbol("act-1103/all-lanes");

/**
 * Per-event lane fan-in (ACT-1103). For events whose every reaction
 * has a static resolver, the value is the union of those reactions'
 * declared lanes — `do()` arms only those controllers on commit. For
 * events with at least one dynamic resolver, the value is
 * {@link ALL_LANES}; `do()` falls back to arming every controller.
 *
 * @internal
 */
export type EventLaneSet = ReadonlySet<string> | typeof ALL_LANES;

export type Classification = {
  readonly static_targets: StaticTarget[];
  readonly has_dynamic_resolvers: boolean;
  readonly reactive_events: ReadonlySet<string>;
  readonly event_to_state: ReadonlyMap<string, State<any, any, any>>;
  readonly event_to_lanes: ReadonlyMap<string, EventLaneSet>;
};

/**
 * Walk the registry once to collect static reaction targets, the dynamic-
 * resolvers flag, the set of reactive event names, and the event-to-state
 * map. Static targets are deduplicated by (target, source) — two reactions
 * routing to the same projection produce one subscription.
 *
 * @internal
 */
export function classify_registry<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
>(
  registry: Registry<TSchemaReg, TEvents, TActions>,
  states: ReadonlyMap<string, State<Schema, any, any>>
): Classification {
  const statics = new Map<string, StaticTarget>();
  // Per-target lane, checked across EVERY reaction to a target regardless of
  // source (#1325). A stream drains on exactly one lane, and `subscribe`
  // keys lane per-target with last-writer-wins semantics, so lane must agree
  // target-wide — the `(target, source)` scoping of `statics` is too narrow
  // to catch a same-target/different-source lane disagreement.
  const target_lanes = new Map<string, string | undefined>();
  const reactive_events = new Set<string>();
  const event_to_lanes = new Map<string, EventLaneSet>();
  let has_dynamic_resolvers = false;

  for (const [name, register] of Object.entries(registry.events)) {
    if (register.reactions.size > 0) reactive_events.add(name);
    for (const reaction of register.reactions.values()) {
      if (typeof reaction.resolver === "function") {
        has_dynamic_resolvers = true;
        // Dynamic resolver — lane is opaque until runtime. Mark the
        // event as wildcard so `do()` falls back to arming every
        // controller for any commit of it.
        event_to_lanes.set(name, ALL_LANES);
      } else {
        const { target, source, priority = 0, lane } = reaction.resolver;
        const lane_name = lane ?? "default";
        const existing_lanes = event_to_lanes.get(name);
        if (existing_lanes !== ALL_LANES) {
          const set =
            (existing_lanes as Set<string> | undefined) ?? new Set<string>();
          set.add(lane_name);
          event_to_lanes.set(name, set);
        }
        // ACT-1103 / #1325: lanes don't merge — any two reactions to the
        // same target must declare the same lane, regardless of source.
        // First reaction to a target records its lane; every later one must
        // match or it's a config error caught at build time.
        if (!target_lanes.has(target)) {
          target_lanes.set(target, lane);
        } else if (
          (target_lanes.get(target) ?? undefined) !== (lane ?? undefined)
        ) {
          throw new Error(
            `Stream "${target}" has conflicting lane assignments ` +
              `("${target_lanes.get(target) ?? "default"}" vs "${lane ?? "default"}")`
          );
        }
        const key = `${target}|${source ?? ""}`;
        const existing = statics.get(key);
        if (!existing) {
          statics.set(key, { stream: target, source, priority, lane });
        } else if (priority > (existing.priority as number)) {
          // Multiple reactions with the same (target, source) — keep the max
          // priority so the highest-priority registrant sets the scheduling
          // priority (mirrors subscribe-side semantics). `existing.priority`
          // is always defined here since we always set it when inserting, but
          // the StaticTarget type marks it optional for external consumers.
          statics.set(key, { ...existing, priority });
        }
      }
    }
  }

  // Event-name → owning state. Duplicate event names are rejected at
  // registration time (merge.ts), so each entry is unambiguous.
  const event_to_state = new Map<string, State<any, any, any>>();
  for (const merged of states.values()) {
    for (const event_name of Object.keys(merged.events)) {
      event_to_state.set(event_name, merged);
    }
  }

  return {
    static_targets: [...statics.values()],
    has_dynamic_resolvers,
    reactive_events,
    event_to_state,
    event_to_lanes,
  };
}
