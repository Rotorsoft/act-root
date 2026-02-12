/**
 * @module slice-builder
 * @category Builders
 *
 * Fluent builder for composing partial states with scoped reactions into
 * self-contained functional slices (vertical slice architecture).
 */
import { _this_, _void_, registerState } from "./merge.js";
import type {
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Schema,
  SchemaRegister,
  Schemas,
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
  M extends Record<string, Schema> = Record<string, never>,
> = {
  readonly _tag: "Slice";
  readonly states: Map<string, State<any, any, any>>;
  readonly events: EventRegister<E>;
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
 * Provides the same chainable API as ActBuilder for registering states
 * and defining reactions, but scoped to the slice's own events.
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
  M extends Record<string, Schema> = Record<string, never>,
> = {
  /**
   * Registers a partial state definition with the slice.
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
   * Begins defining a reaction scoped to this slice's events.
   */
  on: <K extends keyof E>(
    event: K
  ) => {
    do: (
      handler: ReactionHandler<E, K>,
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
 * @example Single-state slice
 * ```typescript
 * const CounterSlice = slice()
 *   .with(Counter)
 *   .on("Incremented")
 *     .do(async (event) => { console.log("incremented!", event.data); })
 *     .void()
 *   .build();
 *
 * const app = act()
 *   .with(CounterSlice)
 *   .build();
 * ```
 *
 * @example Multi-slice composition
 * ```typescript
 * const CreationSlice = slice()
 *   .with(TicketCreation)
 *   .on("TicketOpened").do(assign)
 *   .build();
 *
 * const MessagingSlice = slice()
 *   .with(TicketMessaging)
 *   .on("MessageAdded").do(deliver)
 *   .build();
 *
 * const app = act()
 *   .with(CreationSlice)
 *   .with(MessagingSlice)
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
  events: EventRegister<E> = {} as any
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
      registerState(state, states, actions, events as Record<string, any>);
      return slice<
        S & { [K in keyof AX]: SX },
        E & EX,
        A & AX,
        M & { [K in NX]: SX }
      >(states, actions, events as unknown as EventRegister<E & EX>);
    },
    on: <K extends keyof E>(event: K) => ({
      do: (
        handler: ReactionHandler<E, K>,
        options?: Partial<ReactionOptions>
      ) => {
        const reaction: Reaction<E, K> = {
          handler,
          resolver: _this_,
          options: {
            blockOnError: options?.blockOnError ?? true,
            maxRetries: options?.maxRetries ?? 3,
          },
        };
        events[event].reactions.set(handler.name, reaction);
        return {
          ...builder,
          to(resolver: ReactionResolver<E, K> | string) {
            events[event].reactions.set(handler.name, {
              ...reaction,
              resolver:
                typeof resolver === "string" ? { target: resolver } : resolver,
            });
            return builder;
          },
          void() {
            events[event].reactions.set(handler.name, {
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
    }),
    events,
  };
  return builder;
}
