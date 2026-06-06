/**
 * @module slice-builder
 * @category Builders
 *
 * Fluent builder for composing partial states with scoped reactions into
 * self-contained functional slices (vertical slice architecture).
 */
import { _this_, register_state } from "../internal/index.js";
import { DEFAULT_LANE } from "../ports.js";
import type {
  Actor,
  Committed,
  EventRegister,
  IAct,
  LaneConfig,
  Reaction,
  ReactionOptions,
  ReactionResolver,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
} from "../types/index.js";
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
export type SliceBuilder<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> = {
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
   * Embeds a built Projection within this slice. The projection's events
   * must be a subset of events from states already registered via
   * `.withState()`. Projection handlers preserve their `(event, stream)`
   * signature and do not receive the app interface.
   */
  withProjection: <TNewEvents extends Schemas>(
    projection: [Exclude<keyof TNewEvents, keyof TEvents>] extends [never]
      ? Projection<TNewEvents>
      : never
  ) => SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>;
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
   * Begins defining a reaction scoped to this slice's events.
   */
  on: <TKey extends keyof TEvents>(
    event: TKey
  ) => {
    do: (
      handler: (
        event: Committed<TEvents, TKey>,
        stream: string,
        app: IAct<TEvents, TActions, TActor>
      ) => Promise<Snapshot<Schema, TEvents> | void>,
      options?: Partial<ReactionOptions>
    ) => SliceBuilder<
      TSchemaReg,
      TEvents,
      TActions,
      TStateMap,
      TActor,
      TLanes
    > & {
      to: (
        resolver: ReactionResolver<TEvents, TKey, TLanes> | string
      ) => SliceBuilder<
        TSchemaReg,
        TEvents,
        TActions,
        TStateMap,
        TActor,
        TLanes
      >;
    };
  };
  /**
   * Builds and returns the Slice data structure.
   */
  build: () => Slice<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<TEvents>;
};

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
 *     await app.do("AssignTicket", target, payload, event);
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
      if (config.name === DEFAULT_LANE)
        throw new Error(`Lane "${DEFAULT_LANE}" is reserved`);
      if (lanes.some((l) => l.name === config.name))
        throw new Error(`Lane "${config.name}" was already declared`);
      lanes.push(config);
      return builder as never;
    },
    on: <TKey extends keyof TEvents>(event: TKey) => ({
      do: (
        handler: (
          event: Committed<TEvents, TKey>,
          stream: string,
          app: IAct<TEvents, TActions, TActor>
        ) => Promise<Snapshot<Schema, TEvents> | void>,
        options?: Partial<ReactionOptions>
      ) => {
        const reaction: Reaction<TEvents, TKey, TActions, TActor> = {
          handler: handler,
          resolver: _this_,
          options: {
            blockOnError: options?.blockOnError ?? true,
            maxRetries: options?.maxRetries ?? 3,
            backoff: options?.backoff,
          },
        };
        if (!handler.name)
          throw new Error(
            `Reaction handler for "${String(event)}" must be a named function`
          );
        // Register once with the default _this_ resolver. If `.to()` is
        // chained next, it patches the same reaction's resolver in place
        // — no second Map.set() round-trip.
        events[event].reactions.set(handler.name, reaction);
        return Object.assign(builder, {
          to(resolver: ReactionResolver<TEvents, TKey> | string) {
            reaction.resolver =
              typeof resolver === "string" ? { target: resolver } : resolver;
            return builder;
          },
        });
      },
    }),
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
