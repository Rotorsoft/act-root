/**
 * @module slice-builder
 * @category Builders
 *
 * Fluent builder for composing partial states with scoped reactions into
 * self-contained functional slices (vertical slice architecture).
 */

import { resolveLaneConfig } from "../internal/config.js";
import type { Projection, Slice, SliceBuilder } from "../types/builders.js";
import type {
  Actor,
  EventRegister,
  LaneConfig,
  Schema,
  SchemaRegister,
  Schemas,
  State,
} from "../types/index.js";
import { reaction_on, register_lane } from "./builder-utils.js";
import { register_state } from "./merge.js";

/* eslint-disable @typescript-eslint/no-empty-object-type -- {} used as generic defaults */

/**
 * Creates a new slice builder for composing partial states with scoped reactions.
 *
 * Slices enable vertical slice architecture by grouping related states and
 * reactions into self-contained feature modules. Reactions defined in a slice
 * are type-scoped to events from that slice's states only.
 *
 * @example Single-state slice with typed dispatch
 * ```typescript
 * const CounterSlice = slice()
 *   .withState(Counter)
 *   .on("Incremented")
 *     .do(async function resetCounter(event, _stream, app) {
 *       await app.do("reset", target, {});
 *     })
 *     .to("counter-target")
 *   .build();
 * ```
 *
 * @see {@link SliceBuilder} for builder methods
 * @see {@link Slice} for the output type
 */
export function slice<
  // @ts-expect-error empty schema
  TSchemaReg extends SchemaRegister<TActions> = {},
  TEvents extends Schemas = {},
  TActions extends Schemas = {},
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
>(): SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> {
  // One mutable state shared across the entire fluent chain. Each
  // `withState` / `withProjection` / `on` call mutates these and returns
  // the same builder cast to the widened generic; type fanout is preserved
  // through the public type signatures, runtime allocation is not.
  const states = new Map<string, State<any, any, any>>();
  const actions: Record<string, any> = {};
  const events = {} as EventRegister<TEvents>;
  const projections: Projection<any>[] = [];
  const lanes: LaneConfig[] = [];

  const builder: SliceBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TActor
  > = {
    withState: (state) => {
      register_state(state, states, actions, events as Record<string, unknown>);
      return builder as never;
    },
    withProjection: (proj) => {
      projections.push(proj as Projection<any>);
      return builder;
    },
    withLane: (config) => {
      // Validate at declaration, exactly as the `act()` path does. Without
      // this the slice path accepted a bag the act() path rejects — and a
      // lane carrying a bad streamLimit/leaseMillis/cycleMs drains nothing
      // for the life of the process, silently: no error, no log, and nothing
      // in `blocked_streams()` to find it by.
      register_lane(resolveLaneConfig(config), lanes);
      return builder as never;
    },
    on: <TKey extends keyof TEvents>(event: TKey) =>
      reaction_on(event, events, builder) as never,
    build: () => ({
      _tag: "Slice" as const,
      states,
      events,
      projections,
      lanes,
    }),
    events,
  };
  return builder;
}
