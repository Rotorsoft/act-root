/**
 * @module builder-utils
 * @category Internal
 *
 * Shared builder machinery reused by both `act-builder.ts` and
 * `slice-builder.ts`. The two builders expose the same reaction-registration
 * and lane-declaration surface and differ only in the concrete builder type
 * they return (`ActBuilder` vs `SliceBuilder`) and the event register they
 * write into (`registry.events` vs the slice's `events`). This module owns the
 * one copy of that logic so the builders stay thin delegations.
 *
 * @internal
 */

import {
  DEFAULT_BLOCK_ON_ERROR,
  DEFAULT_MAX_RETRIES,
  resolveLaneConfig,
  resolveReactionConfig,
} from "../internal/config.js";
import {
  assert_defer_when,
  type DeferSchedule,
  make_deferred,
} from "../internal/defer-config.js";
import type {
  Committed,
  EventRegister,
  LaneConfig,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Schemas,
} from "../types/index.js";
import { DEFAULT_LANE } from "../types/index.js";
import { _this_ } from "./merge.js";

/**
 * Validate and register a drain lane, the one rule for `withLane` on an Act
 * or a slice and for the lanes a slice brings to `withSlice`, in any order.
 * Validating here means a bad lane bag throws at declaration, not by
 * silently draining nothing. `"default"` is reserved; a name declares one
 * config, so declaring it again with the same config is a no-op and with a
 * different one throws. Mutates `lanes` in place.
 *
 * @internal
 */
export function register_lane(config: LaneConfig, lanes: LaneConfig[]): void {
  resolveLaneConfig(config);
  if (config.name === DEFAULT_LANE)
    throw new Error(`Lane "${DEFAULT_LANE}" is reserved`);
  const existing = lanes.find((l) => l.name === config.name);
  if (!existing) return void lanes.push(config);
  if (
    existing.leaseMillis !== config.leaseMillis ||
    existing.streamLimit !== config.streamLimit ||
    existing.cycleMs !== config.cycleMs
  )
    throw new Error(
      `Lane "${config.name}" was already declared with a different config`
    );
}

/**
 * Build the `.on(event)` step shared by both builders. Registers a reaction
 * (named-function + duplicate guards, fail-fast literal-schedule validation,
 * the default `_this_` resolver, and the `.defer` handler wrap) into
 * `events[event].reactions`, and hands back `builder` patched with `.to(...)`
 * for in-place resolver routing.
 *
 * The strict, builder-specific type is supplied by each builder's own `on`
 * signature ({@link ReactionOn}); the runtime here is builder-agnostic.
 *
 * @internal
 */
export function reaction_on<
  TEvents extends Schemas,
  TKey extends keyof TEvents,
  TBuilder,
>(event: TKey, events: EventRegister<TEvents>, builder: TBuilder) {
  const register = (
    handler: ReactionHandler<TEvents, TKey>,
    options?: Partial<ReactionOptions>,
    schedule?: DeferSchedule<Committed<TEvents, TKey>>
  ) => {
    if (!handler.name)
      throw new Error(
        `Reaction handler for "${String(event)}" must be a named function`
      );
    if (events[event].reactions.has(handler.name))
      throw new Error(
        `Duplicate reaction "${handler.name}" for event "${String(event)}". ` +
          `Reaction handlers are keyed by function name; rename one of them.`
      );
    // Fail fast on a bad literal schedule; the function form is checked when it
    // runs (no event to resolve against at build time).
    if (schedule && typeof schedule !== "function") assert_defer_when(schedule);
    const reaction: Reaction<TEvents, TKey> = {
      handler: schedule ? make_deferred(handler, schedule) : handler,
      resolver: _this_,
      // Validate the whole bag at the declaration site so a bad
      // `maxRetries`/`backoff`/`blockOnError` throws ZodError at build,
      // not a NaN gate on the first retry.
      options: resolveReactionConfig({
        blockOnError: options?.blockOnError ?? DEFAULT_BLOCK_ON_ERROR,
        maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
        backoff: options?.backoff,
      }),
    };
    // Register once with the default _this_ resolver. If `.to()` is chained
    // next, it patches the same reaction's resolver in place — no second
    // Map.set() round-trip.
    events[event].reactions.set(handler.name, reaction);
    return Object.assign(builder as object, {
      to(resolver: ReactionResolver<TEvents, TKey> | string) {
        reaction.resolver =
          typeof resolver === "string" ? { target: resolver } : resolver;
        return builder;
      },
    });
  };
  return {
    do: (
      handler: ReactionHandler<TEvents, TKey>,
      options?: Partial<ReactionOptions>
    ) => register(handler, options),
    defer: (schedule: DeferSchedule<Committed<TEvents, TKey>>) => ({
      do: (
        handler: ReactionHandler<TEvents, TKey>,
        options?: Partial<ReactionOptions>
      ) => register(handler, options, schedule),
    }),
  };
}
