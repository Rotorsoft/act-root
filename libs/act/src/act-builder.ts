/**
 * @module act-builder
 * @category Builders
 *
 * Fluent builder for composing event-sourced applications.
 */
import { Act } from "./act.js";
import { _this_, _void_, registerState } from "./merge.js";
import { isSlice, type Slice } from "./slice-builder.js";
import type {
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  State,
} from "./types/index.js";

/**
 * Fluent builder interface for composing event-sourced applications.
 *
 * Provides a chainable API for:
 * - Registering states or slices via `.with()`
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
  M extends Record<string, Schema> = Record<string, never>,
> = {
  /**
   * Registers a state definition or a slice with the builder.
   *
   * When receiving a State, it registers the state's actions and events.
   * When receiving a Slice, it merges all the slice's states and reactions.
   * State names, action names, and event names must be unique across the application
   * (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   *
   * @example Register a state
   * ```typescript
   * const app = act().with(Counter).build();
   * ```
   *
   * @example Register a slice
   * ```typescript
   * const CounterSlice = slice().with(Counter).on("Incremented").do(log).void().build();
   * const app = act().with(CounterSlice).build();
   * ```
   */
  with: (<
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
  >) &
    (<
      SX extends SchemaRegister<AX>,
      EX extends Schemas,
      AX extends Schemas,
      MX extends Record<string, Schema>,
    >(
      slice: Slice<SX, EX, AX, MX>
    ) => ActBuilder<S & SX, E & EX, A & AX, M & MX>);
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
   *
   * @example
   * ```typescript
   * const app = act()
   *   .with(User)
   *   .on("UserCreated")  // React to UserCreated events
   *     .do(async (event) => {
   *       await sendWelcomeEmail(event.data.email);
   *     })
   *     .void()
   *   .build();
   * ```
   */
  on: <K extends keyof E>(
    event: K
  ) => {
    /**
     * Defines the reaction handler function for the event.
     *
     * The handler receives the committed event and can:
     * - Perform side effects (send emails, call APIs, etc.)
     * - Return an action tuple `[actionName, payload]` to trigger another action
     * - Return `void` or `undefined` for side-effect-only reactions
     *
     * @param handler - The reaction handler function
     * @param options - Optional reaction configuration
     * @param options.blockOnError - Block this stream if handler fails (default: true)
     * @param options.maxRetries - Maximum retry attempts on failure (default: 3)
     * @returns The builder with `.to()` and `.void()` methods for routing configuration
     */
    do: (
      handler: ReactionHandler<E, K>,
      options?: Partial<ReactionOptions>
    ) => ActBuilder<S, E, A, M> & {
      /**
       * Routes the reaction to a specific target stream.
       *
       * @param resolver - Target stream name (string) or resolver function
       * @returns The builder for chaining
       */
      to: (resolver: ReactionResolver<E, K> | string) => ActBuilder<S, E, A, M>;
      /**
       * Marks the reaction as void (side-effect only, no target stream).
       *
       * @returns The builder for chaining
       */
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
 * The Act orchestrator is responsible for:
 * - Managing state instances (aggregates)
 * - Executing actions and committing events
 * - Processing reactions (event handlers)
 * - Coordinating event-driven workflows
 *
 * Use the fluent API to register states or slices with `.with()`, define event
 * reactions with `.on()`, and build the orchestrator with `.build()`.
 *
 * @template S - State schema register type
 * @template E - Event schemas type
 * @template A - Action schemas type
 * @returns An ActBuilder instance for fluent API configuration
 *
 * @example Basic application with single state
 * ```typescript
 * import { act, state } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const Counter = state("Counter", z.object({ count: z.number() }))
 *   .init(() => ({ count: 0 }))
 *   .emits({ Incremented: z.object({ amount: z.number() }) })
 *   .patch({ Incremented: (event, state) => ({ count: state.count + event.data.amount }) })
 *   .on("increment", z.object({ by: z.number() }))
 *     .emit((action) => ["Incremented", { amount: action.by }])
 *   .build();
 *
 * const app = act()
 *   .with(Counter)
 *   .build();
 * ```
 *
 * @example Application with slices (vertical slice architecture)
 * ```typescript
 * import { act, slice, state } from "@rotorsoft/act";
 *
 * const CounterSlice = slice()
 *   .with(Counter)
 *   .on("Incremented")
 *     .do(async (event) => { console.log("incremented!"); })
 *     .void()
 *   .build();
 *
 * const app = act()
 *   .with(CounterSlice)
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
    actions: {} as any,
    events: {} as any,
  }
): ActBuilder<S, E, A, M> {
  const builder: ActBuilder<S, E, A, M> = {
    with: ((input: State<any, any, any> | Slice<any, any, any, any>) => {
      if (isSlice(input)) {
        // SLICE: merge all states and copy reactions
        for (const s of input.states.values()) {
          registerState(s, states, registry.actions, registry.events);
        }
        // Copy reactions from slice's event register
        for (const eventName of Object.keys(input.events)) {
          const sliceRegister = input.events[eventName];
          if ((registry.events as any)[eventName]) {
            for (const [name, reaction] of sliceRegister.reactions) {
              (registry.events as any)[eventName].reactions.set(name, reaction);
            }
          }
        }
        return act(states, registry as Registry<any, any, any>);
      }
      // STATE: register directly
      registerState(input, states, registry.actions, registry.events);
      return act(states, registry as Registry<any, any, any>);
    }) as any,
    /**
     * Adds a reaction to an event.
     *
     * @template K The type of event
     * @param event The event to add a reaction to
     * @returns The builder
     */
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
        registry.events[event].reactions.set(handler.name, reaction);
        return {
          ...builder,
          to(resolver: ReactionResolver<E, K> | string) {
            registry.events[event].reactions.set(handler.name, {
              ...reaction,
              resolver:
                typeof resolver === "string" ? { target: resolver } : resolver,
            });
            return builder;
          },
          void() {
            registry.events[event].reactions.set(handler.name, {
              ...reaction,
              resolver: _void_,
            });
            return builder;
          },
        };
      },
    }),
    build: () => new Act<S, E, A, M>(registry, states),
    events: registry.events,
  };
  return builder;
}
