/**
 * @module slice-builder
 * @category Builders
 *
 * Fluent builder for composing partial states with scoped reactions into
 * self-contained functional slices (vertical slice architecture).
 */
import {
  reaction_on,
  register_lane,
  register_state,
} from "../internal/index.js";
import type { DEFAULT_LANE } from "../ports.js";
import type {
  Actor,
  EventRegister,
  LaneConfig,
  Schema,
  SchemaRegister,
  Schemas,
  State,
} from "../types/index.js";
import type { BuilderBase } from "./builder-base.js";
import type { Projection } from "./projection-builder.js";

/**
 * A self-contained functional slice grouping partial states with their
 * scoped reactions. Slices are composed into an Act orchestrator via
 * `act().withSlice(slice)`.
 *
 * @template TSchemaReg - Schema register for states
 * @template TEvents - Event schemas from this slice's states
 * @template TActions - Action schemas from this slice's states
 * @template TStateMap - Map of state names to state schemas
 * @template TActor - Actor type extending base Actor
 */
export type Slice<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> = {
  readonly _tag: "Slice";
  readonly states: Map<string, State<any, any, any>>;
  readonly events: EventRegister<TEvents>;
  readonly projections: ReadonlyArray<Projection<any>>;
  /**
   * Drain lanes declared on this slice via `.withLane(...)` (ACT-1103).
   * `act().withSlice(slice)` merges these into the Act's lane set so
   * `.to({lane})` is statically checked at the slice's call site against
   * the lanes the slice itself declared.
   */
  readonly lanes: ReadonlyArray<LaneConfig>;
  /** @internal phantom field for type-level state schema tracking */
  readonly _S?: TSchemaReg;
  /** @internal phantom field for type-level state name tracking */
  readonly _M?: TStateMap;
  /** @internal phantom field for type-level actor tracking */
  readonly _TActor?: TActor;
  /** @internal phantom field for type-level lane union tracking */
  readonly _TLanes?: TLanes;
};

/**
 * Fluent builder interface for composing functional slices.
 *
 * Provides a chainable API for registering states and projections,
 * and defining reactions scoped to the slice's own events.
 *
 * @template TSchemaReg - Schema register for states
 * @template TEvents - Event schemas
 * @template TActions - Action schemas
 * @template TStateMap - Map of state names to state schemas
 * @template TActor - Actor type extending base Actor
 */
export interface SliceBuilder<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> extends BuilderBase<
    SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>,
    TEvents,
    TActions,
    TActor,
    TLanes
  > {
  /**
   * Registers a state definition with the slice.
   *
   * Include every state whose actions your reaction handlers need to
   * dispatch. Duplicate registrations (same state in multiple slices)
   * are handled automatically at composition time.
   */
  withState: <
    TNewState extends Schema,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
    TNewName extends string = string,
  >(
    state: State<TNewState, TNewEvents, TNewActions, TNewName>
  ) => SliceBuilder<
    TSchemaReg & { [K in keyof TNewActions]: TNewState },
    TEvents & TNewEvents,
    TActions & TNewActions,
    TStateMap & { [K in TNewName]: TNewState },
    TActor,
    TLanes
  >;
  /**
   * Declares a drain lane on this slice (ACT-1103). Merged into the
   * parent Act's lane set by `act().withSlice(slice)`.
   */
  withLane: <const TConfig extends LaneConfig>(
    config: TConfig
  ) => SliceBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TActor,
    TLanes | TConfig["name"]
  >;
  /**
   * Builds and returns the Slice data structure.
   */
  build: () => Slice<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>;
}

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
 *     .do(async (event, _stream, app) => {
 *       await app.do("reset", target, {});
 *     })
 *     .to("counter-target")
 *   .build();
 * ```
 *
 * @example Cross-state dispatch (include both states)
 * ```typescript
 * const CreationSlice = slice()
 *   .withState(TicketCreation)
 *   .withState(TicketOperations) // handler can dispatch AssignTicket
 *   .on("TicketOpened").do(async (event, _stream, app) => {
 *     await app.do("AssignTicket", target, payload, { reactingTo: event });
 *   })
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
      register_lane(config, lanes);
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
