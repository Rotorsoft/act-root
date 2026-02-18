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
 * `act().with(slice)`.
 *
 * @template S - Schema register for states
 * @template E - Event schemas from this slice's states
 * @template A - Action schemas from this slice's states
 * @template M - Map of state names to state schemas
 */
export type Slice<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  M extends Record<string, Schema> = {},
> = {
  readonly _tag: "Slice";
  readonly states: Map<string, State<any, any, any>>;
  readonly events: EventRegister<E>;
  readonly projections: ReadonlyArray<Projection<any>>;
  /** @internal phantom field for type-level state schema tracking */
  readonly _S?: S;
  /** @internal phantom field for type-level state name tracking */
  readonly _M?: M;
};

/**
 * Type guard for distinguishing Slice from State objects.
 */
export function isSlice(x: any): x is Slice<any, any, any, any> {
  return x != null && x._tag === "Slice";
}

/**
 * Fluent builder interface for composing functional slices.
 *
 * Provides a chainable API for registering states and defining reactions,
 * scoped to the slice's own events. Include all states whose actions your
 * handlers need via `.with()` — the `app` parameter in `.do()` handlers
 * is typed with every action registered in the slice.
 *
 * @template S - Schema register for states
 * @template E - Event schemas
 * @template A - Action schemas
 * @template M - Map of state names to state schemas
 */
export type SliceBuilder<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  M extends Record<string, Schema> = {},
> = {
  /**
   * Registers a partial state definition with the slice.
   *
   * Include every state whose actions your reaction handlers need to
   * dispatch. Duplicate registrations (same state in multiple slices)
   * are handled automatically at composition time.
   */
  with: <
    SX extends Schema,
    EX extends Schemas,
    AX extends Schemas,
    NX extends string = string,
  >(
    state: State<SX, EX, AX, NX>
  ) => SliceBuilder<
    S & { [K in keyof AX]: SX },
    E & EX,
    A & AX,
    M & { [K in NX]: SX }
  >;
  /**
   * Embeds a built Projection within this slice for encapsulated
   * feature composition. The projection's events must be a subset
   * of events from states already registered via `.with()`.
   * Projection handlers preserve their `(event, stream)` signature
   * and do not receive a Dispatcher.
   */
  projection: <EP extends Schemas>(
    proj: [Exclude<keyof EP, keyof E>] extends [never] ? Projection<EP> : never
  ) => SliceBuilder<S, E, A, M>;
  /**
   * Begins defining a reaction scoped to this slice's events.
   */
  on: <K extends keyof E>(
    event: K
  ) => {
    do: (
      handler: (
        event: Committed<E, K>,
        stream: string,
        app: Dispatcher<A>
      ) => Promise<Snapshot<Schema, E> | void>,
      options?: Partial<ReactionOptions>
    ) => SliceBuilder<S, E, A, M> & {
      to: (
        resolver: ReactionResolver<E, K> | string
      ) => SliceBuilder<S, E, A, M>;
      void: () => SliceBuilder<S, E, A, M>;
    };
  };
  /**
   * Builds and returns the Slice data structure.
   */
  build: () => Slice<S, E, A, M>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<E>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type -- {} used as generic defaults */

/**
 * Creates a new slice builder for composing partial states with scoped reactions.
 *
 * Slices enable vertical slice architecture by grouping related states and
 * reactions into self-contained feature modules. Reactions defined in a slice
 * are type-scoped to events from that slice's states only.
 *
 * Include all states whose actions your handlers dispatch via `.with()`.
 * When multiple slices share the same state, duplicates are merged
 * automatically at `act().with(slice)` composition time.
 *
 * @example Single-state slice with typed dispatch
 * ```typescript
 * const CounterSlice = slice()
 *   .with(Counter)
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
 *   .with(TicketCreation)
 *   .with(TicketOperations) // handler can dispatch AssignTicket
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
  S extends SchemaRegister<A> = {},
  E extends Schemas = {},
  A extends Schemas = {},
  M extends Record<string, Schema> = {},
>(
  states: Map<string, State<any, any, any>> = new Map(),
  actions: Record<string, any> = {},
  events: EventRegister<E> = {} as EventRegister<E>,
  projections: Projection<any>[] = []
): SliceBuilder<S, E, A, M> {
  const builder: SliceBuilder<S, E, A, M> = {
    with: <
      SX extends Schema,
      EX extends Schemas,
      AX extends Schemas,
      NX extends string = string,
    >(
      state: State<SX, EX, AX, NX>
    ) => {
      registerState(state, states, actions, events as Record<string, unknown>);
      return slice<
        S & { [K in keyof AX]: SX },
        E & EX,
        A & AX,
        M & { [K in NX]: SX }
      >(
        states,
        actions,
        events as unknown as EventRegister<E & EX>,
        projections
      );
    },
    projection: <EP extends Schemas>(proj: Projection<EP>) => {
      projections.push(proj);
      return slice<S, E, A, M>(states, actions, events, projections);
    },
    on: <K extends keyof E>(event: K) => ({
      do: (
        handler: (
          event: Committed<E, K>,
          stream: string,
          app: Dispatcher<A>
        ) => Promise<Snapshot<Schema, E> | void>,
        options?: Partial<ReactionOptions>
      ) => {
        const reaction: Reaction<E, K, A> = {
          handler: handler as ReactionHandler<E, K, A>,
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
          to(resolver: ReactionResolver<E, K> | string) {
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
