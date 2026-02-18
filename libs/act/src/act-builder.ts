/**
 * @module act-builder
 * @category Builders
 *
 * Fluent builder for composing event-sourced applications.
 */
import { Act } from "./act.js";
import { _this_, _void_, mergeProjection, registerState } from "./merge.js";
import type { Projection } from "./projection-builder.js";
import type { Slice } from "./slice-builder.js";
import type {
  Committed,
  Dispatcher,
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
} from "./types/index.js";

/**
 * Fluent builder interface for composing event-sourced applications.
 *
 * Provides a chainable API for:
 * - Registering states via `.withState()`
 * - Registering slices via `.withSlice()`
 * - Registering projections via `.withProjection()`
 * - Defining event reactions via `.on()` → `.do()` → `.to()` or `.void()`
 * - Building the orchestrator via `.build()`
 *
 * @template S - Schema register for states (maps action names to state schemas)
 * @template E - Event schemas (maps event names to event data schemas)
 * @template A - Action schemas (maps action names to action payload schemas)
 *
 * @see {@link act} for usage examples
 * @see {@link Act} for the built orchestrator API
 */
export type ActBuilder<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  M extends Record<string, Schema> = {},
> = {
  /**
   * Registers a state definition with the builder.
   *
   * State names, action names, and event names must be unique across the
   * application (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   */
  withState: <
    SX extends Schema,
    EX extends Schemas,
    AX extends Schemas,
    NX extends string = string,
  >(
    state: State<SX, EX, AX, NX>
  ) => ActBuilder<
    S & { [K in keyof AX]: SX },
    E & EX,
    A & AX,
    M & { [K in NX]: SX }
  >;
  /**
   * Registers a slice with the builder.
   *
   * Merges all the slice's states and reactions into the application.
   * State names, action names, and event names must be unique across the
   * application (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   */
  withSlice: <
    SX extends SchemaRegister<AX>,
    EX extends Schemas,
    AX extends Schemas,
    MX extends Record<string, Schema>,
  >(
    slice: Slice<SX, EX, AX, MX>
  ) => ActBuilder<S & SX, E & EX, A & AX, M & MX>;
  /**
   * Registers a standalone projection with the builder.
   *
   * The projection's events must be a subset of events already registered
   * via `.withState()` or `.withSlice()`.
   */
  withProjection: <EX extends Schemas>(
    projection: [Exclude<keyof EX, keyof E>] extends [never]
      ? Projection<EX>
      : never
  ) => ActBuilder<S, E, A, M>;
  /**
   * Begins defining a reaction to a specific event.
   *
   * Reactions are event handlers that respond to state changes. They can trigger
   * additional actions, update external systems, or perform side effects. Reactions
   * are processed asynchronously during drain cycles.
   *
   * @template K - Event name (must be a registered event)
   * @param event - The event name to react to
   * @returns An object with `.do()` method to define the reaction handler
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
    ) => ActBuilder<S, E, A, M> & {
      to: (resolver: ReactionResolver<E, K> | string) => ActBuilder<S, E, A, M>;
      void: () => ActBuilder<S, E, A, M>;
    };
  };
  /**
   * Builds and returns the Act orchestrator instance.
   *
   * @param drainLimit - Deprecated parameter, no longer used
   * @returns The Act orchestrator instance
   *
   * @see {@link Act} for available orchestrator methods
   */
  build: (drainLimit?: number) => Act<S, E, A, M>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<E>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type -- {} used as generic defaults */

/**
 * Creates a new Act orchestrator builder for composing event-sourced applications.
 *
 * @example Basic application with single state
 * ```typescript
 * const app = act()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @example Application with slices (vertical slice architecture)
 * ```typescript
 * const CounterSlice = slice()
 *   .withState(Counter)
 *   .on("Incremented")
 *     .do(async (event) => { console.log("incremented!"); })
 *     .void()
 *   .build();
 *
 * const app = act()
 *   .withSlice(CounterSlice)
 *   .build();
 * ```
 *
 * @see {@link ActBuilder} for available builder methods
 * @see {@link Act} for orchestrator API methods
 * @see {@link state} for defining states
 * @see {@link slice} for defining slices
 */
export function act<
  // @ts-expect-error empty schema
  S extends SchemaRegister<A> = {},
  E extends Schemas = {},
  A extends Schemas = {},
  M extends Record<string, Schema> = {},
>(
  states: Map<string, State<any, any, any>> = new Map(),
  registry: Registry<S, E, A> = {
    actions: {} as Registry<S, E, A>["actions"],
    events: {} as Registry<S, E, A>["events"],
  },
  pendingProjections: Projection<any>[] = []
): ActBuilder<S, E, A, M> {
  const builder: ActBuilder<S, E, A, M> = {
    withState: <
      SX extends Schema,
      EX extends Schemas,
      AX extends Schemas,
      NX extends string = string,
    >(
      state: State<SX, EX, AX, NX>
    ) => {
      registerState(state, states, registry.actions, registry.events);
      return act<
        S & { [K in keyof AX]: SX },
        E & EX,
        A & AX,
        M & { [K in NX]: SX }
      >(
        states,
        registry as unknown as Registry<
          S & { [K in keyof AX]: SX },
          E & EX,
          A & AX
        >,
        pendingProjections
      );
    },
    withSlice: <
      SX extends SchemaRegister<AX>,
      EX extends Schemas,
      AX extends Schemas,
      MX extends Record<string, Schema>,
    >(
      input: Slice<SX, EX, AX, MX>
    ) => {
      for (const s of input.states.values()) {
        registerState(s, states, registry.actions, registry.events);
      }
      for (const eventName of Object.keys(input.events)) {
        const sliceRegister = input.events[eventName];
        for (const [name, reaction] of sliceRegister.reactions) {
          (
            registry.events as Record<
              string,
              { reactions: Map<string, unknown> }
            >
          )[eventName].reactions.set(name, reaction);
        }
      }
      pendingProjections.push(...input.projections);
      return act<S & SX, E & EX, A & AX, M & MX>(
        states,
        registry as unknown as Registry<S & SX, E & EX, A & AX>,
        pendingProjections
      );
    },
    withProjection: <EX extends Schemas>(proj: Projection<EX>) => {
      mergeProjection(proj, registry.events);
      return act<S, E, A, M>(states, registry, pendingProjections);
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
          handler.name ||
          `${String(event)}_${registry.events[event].reactions.size}`;
        registry.events[event].reactions.set(name, reaction);
        return {
          ...builder,
          to(resolver: ReactionResolver<E, K> | string) {
            registry.events[event].reactions.set(name, {
              ...reaction,
              resolver:
                typeof resolver === "string" ? { target: resolver } : resolver,
            });
            return builder;
          },
          void() {
            registry.events[event].reactions.set(name, {
              ...reaction,
              resolver: _void_,
            });
            return builder;
          },
        };
      },
    }),
    build: () => {
      for (const proj of pendingProjections) {
        mergeProjection(proj, registry.events as Record<string, any>);
      }
      return new Act<S, E, A, M>(registry, states);
    },
    events: registry.events,
  };
  return builder;
}
