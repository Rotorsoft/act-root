/**
 * @module slice-builder
 * @category Builders
 *
 * Fluent builder for composing partial states with scoped reactions into
 * self-contained functional slices (vertical slice architecture).
 */
import { _this_, _void_, registerState } from "./merge.js";
import type { Projection } from "./projection-builder.js";
import type {
  Actor,
  Committed,
  Dispatcher,
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
} from "./types/index.js";

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
> = {
  readonly _tag: "Slice";
  readonly states: Map<string, State<any, any, any>>;
  readonly events: EventRegister<TEvents>;
  readonly projections: ReadonlyArray<Projection<any>>;
  /** @internal phantom field for type-level state schema tracking */
  readonly _S?: TSchemaReg;
  /** @internal phantom field for type-level state name tracking */
  readonly _M?: TStateMap;
  /** @internal phantom field for type-level actor tracking */
  readonly _TActor?: TActor;
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
    TActor
  >;
  /**
   * Embeds a built Projection within this slice. The projection's events
   * must be a subset of events from states already registered via
   * `.withState()`. Projection handlers preserve their `(event, stream)`
   * signature and do not receive a Dispatcher.
   */
  withProjection: <TNewEvents extends Schemas>(
    projection: [Exclude<keyof TNewEvents, keyof TEvents>] extends [never]
      ? Projection<TNewEvents>
      : never
  ) => SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
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
        app: Dispatcher<TActions, TActor>
      ) => Promise<Snapshot<Schema, TEvents> | void>,
      options?: Partial<ReactionOptions>
    ) => SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> & {
      to: (
        resolver: ReactionResolver<TEvents, TKey> | string
      ) => SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
      void: () => SliceBuilder<
        TSchemaReg,
        TEvents,
        TActions,
        TStateMap,
        TActor
      >;
    };
  };
  /**
   * Builds and returns the Slice data structure.
   */
  build: () => Slice<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
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
 *     .void()
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
>(
  states: Map<string, State<any, any, any>> = new Map(),
  actions: Record<string, any> = {},
  events: EventRegister<TEvents> = {} as EventRegister<TEvents>,
  projections: Projection<any>[] = []
): SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> {
  const builder: SliceBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TActor
  > = {
    withState: <
      TNewState extends Schema,
      TNewEvents extends Schemas,
      TNewActions extends Schemas,
      TNewName extends string = string,
    >(
      state: State<TNewState, TNewEvents, TNewActions, TNewName>
    ) => {
      registerState(state, states, actions, events as Record<string, unknown>);
      return slice<
        TSchemaReg & { [K in keyof TNewActions]: TNewState },
        TEvents & TNewEvents,
        TActions & TNewActions,
        TStateMap & { [K in TNewName]: TNewState },
        TActor
      >(
        states,
        actions,
        events as unknown as EventRegister<TEvents & TNewEvents>,
        projections
      );
    },
    withProjection: <TNewEvents extends Schemas>(
      proj: Projection<TNewEvents>
    ) => {
      projections.push(proj);
      return slice<TSchemaReg, TEvents, TActions, TStateMap, TActor>(
        states,
        actions,
        events,
        projections
      );
    },
    on: <TKey extends keyof TEvents>(event: TKey) => ({
      do: (
        handler: (
          event: Committed<TEvents, TKey>,
          stream: string,
          app: Dispatcher<TActions, TActor>
        ) => Promise<Snapshot<Schema, TEvents> | void>,
        options?: Partial<ReactionOptions>
      ) => {
        const reaction: Reaction<TEvents, TKey, TActions, TActor> = {
          handler: handler as ReactionHandler<TEvents, TKey, TActions, TActor>,
          resolver: _this_,
          options: {
            blockOnError: options?.blockOnError ?? true,
            maxRetries: options?.maxRetries ?? 3,
          },
        };
        const name =
          handler.name || `${String(event)}_${events[event].reactions.size}`;
        events[event].reactions.set(name, reaction);
        return {
          ...builder,
          to(resolver: ReactionResolver<TEvents, TKey> | string) {
            events[event].reactions.set(name, {
              ...reaction,
              resolver:
                typeof resolver === "string" ? { target: resolver } : resolver,
            });
            return builder;
          },
          void() {
            events[event].reactions.set(name, {
              ...reaction,
              resolver: _void_,
            });
            return builder;
          },
        };
      },
    }),
    build: () => ({
      _tag: "Slice" as const,
      states,
      events,
      projections,
    }),
    events,
  };
  return builder;
}
