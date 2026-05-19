/**
 * @module build-classify
 * @category Internal
 *
 * Build-time classification of the registry + state map. The Act constructor
 * needs four pre-computed inputs to wire its runtime subsystems:
 *
 * - `staticTargets`     — known-up-front reaction targets (statics get
 *                         subscribed once at init; dynamics scan per event)
 * - `hasDynamicResolvers` — short-circuit flag for `correlate()`
 * - `reactiveEvents`    — event names with at least one reaction (drives
 *                         the drain skip-flag in `do()` and `reset()`)
 * - `eventToState`      — event-name → owning state, for `close({restart})`
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
 * Classification result. Returned by {@link classifyRegistry}; consumed
 * piecewise by Act's constructor.
 *
 * @internal
 */
export type Classification = {
  readonly staticTargets: StaticTarget[];
  readonly hasDynamicResolvers: boolean;
  readonly reactiveEvents: ReadonlySet<string>;
  readonly eventToState: ReadonlyMap<string, State<any, any, any>>;
};

/**
 * Walk the registry once to collect static reaction targets, the dynamic-
 * resolvers flag, the set of reactive event names, and the event-to-state
 * map. Static targets are deduplicated by (target, source) — two reactions
 * routing to the same projection produce one subscription.
 *
 * @internal
 */
export function classifyRegistry<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
>(
  registry: Registry<TSchemaReg, TEvents, TActions>,
  states: ReadonlyMap<string, State<Schema, any, any>>
): Classification {
  const statics = new Map<string, StaticTarget>();
  const reactiveEvents = new Set<string>();
  let hasDynamicResolvers = false;

  for (const [name, register] of Object.entries(registry.events)) {
    if (register.reactions.size > 0) reactiveEvents.add(name);
    for (const reaction of register.reactions.values()) {
      if (typeof reaction.resolver === "function") {
        hasDynamicResolvers = true;
      } else {
        const { target, source, priority = 0, lane } = reaction.resolver;
        const key = `${target}|${source ?? ""}`;
        const existing = statics.get(key);
        if (!existing) {
          statics.set(key, { stream: target, source, priority, lane });
        } else {
          // ACT-1103: lanes don't merge — disagreement is a config error.
          if ((existing.lane ?? undefined) !== (lane ?? undefined))
            throw new Error(
              `Stream "${target}" has conflicting lane assignments ` +
                `("${existing.lane ?? "default"}" vs "${lane ?? "default"}")`
            );
          if (priority > (existing.priority as number)) {
            // Multiple reactions with the same (target, source) — keep
            // the max priority so the highest-priority registrant sets
            // the scheduling lane (mirrors subscribe-side semantics).
            // `existing.priority` is always defined here since we always
            // set it when inserting, but the StaticTarget type marks it
            // optional for backwards compat with external consumers.
            statics.set(key, { ...existing, priority });
          }
        }
      }
    }
  }

  // Event-name → owning state. Duplicate event names are rejected at
  // registration time (merge.ts), so each entry is unambiguous.
  const eventToState = new Map<string, State<any, any, any>>();
  for (const merged of states.values()) {
    for (const eventName of Object.keys(merged.events)) {
      eventToState.set(eventName, merged);
    }
  }

  return {
    staticTargets: [...statics.values()],
    hasDynamicResolvers,
    reactiveEvents,
    eventToState,
  };
}
