/**
 * @module act-builder
 * @category Builders
 *
 * Fluent builder for composing event-sourced applications.
 */
import { Act } from "./act.js";
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

// resolves the event stream as source and target (default)
const _this_ = ({ stream }: { stream: string }) => ({
  source: stream,
  target: stream,
});
// resolves to nothing
const _void_ = () => undefined;

/**
 * Fluent builder for composing event-sourced state machines with actions and reactions.
 *
 * Provides a chainable API for registering states, events, and reaction handlers, enabling you to declaratively build complex, reactive applications.
 *
 * @template S SchemaRegister for state
 * @template E Schemas for events
 * @template A Schemas for actions
 *
 * @example
 * const app = act()
 *   .with(Counter)
 *   .on("Incremented").do(async (event) => { ... })
 *   .to(() => "OtherStream")
 *   .build();
 */
export type ActBuilder<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
> = {
  /**
   * Register a state machine with the builder.
   *
   * @template SX The type of state
   * @template EX The type of events
   * @template AX The type of actions
   * @param state The state machine to add
   * @returns The builder (for chaining)
   */
  with: <SX extends Schema, EX extends Schemas, AX extends Schemas>(
    state: State<SX, EX, AX>
  ) => ActBuilder<S & { [K in keyof AX]: SX }, E & EX, A & AX>;
  /**
   * Register a reaction handler for a given event.
   *
   * @template K The event name
   * @param event The event to react to
   * @returns An object with .do(handler) to register the handler
   */
  on: <K extends keyof E>(
    event: K
  ) => {
    /**
     * Register a reaction handler for the event.
     *
     * @param handler The reaction handler function
     * @param options (Optional) Reaction options (retries, blocking, etc.)
     * @returns The builder (for chaining), with .to(resolver) and .void() for advanced routing
     */
    do: (
      handler: ReactionHandler<E, K>,
      options?: Partial<ReactionOptions>
    ) => ActBuilder<S, E, A> & {
      /**
       * Route the reaction to a specific target and optionally source streams (resolver function).
       * @param resolver The resolver function or target stream name (all sources) as a shorthand
       * @returns The builder (for chaining)
       */
      to: (resolver: ReactionResolver<E, K> | string) => ActBuilder<S, E, A>;
      /**
       * Mark the reaction as void (no routing).
       * @returns The builder (for chaining)
       */
      void: () => ActBuilder<S, E, A>;
    };
  };
  /**
   * Build the application and return an Act orchestrator.
   *
   * @param drainLimit (Optional) The maximum number of events to drain per cycle (default: 10)
   * @returns The Act orchestrator instance
   */
  build: (drainLimit?: number) => Act<S, E, A>;
  /**
   * The registered event schemas and reaction maps.
   */
  readonly events: EventRegister<E>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type */

/**
 * Creates an ActBuilder instance for composing event-sourced applications.
 *
 * Use this function to start building your application by chaining `.with()`, `.on()`, and `.build()` calls.
 *
 * @template S The type of state
 * @template E The type of events
 * @template A The type of actions
 * @returns An ActBuilder instance
 *
 * @example
 * const app = act()
 *   .with(Counter)
 *   .on("Incremented").do(async (event) => { ... })
 *   .build();
 */
export function act<
  // @ts-expect-error empty schema
  S extends SchemaRegister<A> = {},
  E extends Schemas = {},
  A extends Schemas = {},
>(
  states: Set<string> = new Set(),
  registry: Registry<S, E, A> = {
    actions: {} as any,
    events: {} as any,
  }
): ActBuilder<S, E, A> {
  const builder: ActBuilder<S, E, A> = {
    /**
     * Adds a state to the builder.
     *
     * @template SX The type of state
     * @template EX The type of events
     * @template AX The type of actions
     * @param state The state to add
     * @returns The builder
     */
    with: <SX extends Schema, EX extends Schemas, AX extends Schemas>(
      state: State<SX, EX, AX>
    ) => {
      if (!states.has(state.name)) {
        states.add(state.name);
        for (const name of Object.keys(state.actions)) {
          if (registry.actions[name])
            throw new Error(`Duplicate action "${name}"`);
          // @ts-expect-error indexed access
          registry.actions[name] = state;
        }
        for (const name of Object.keys(state.events)) {
          if (registry.events[name])
            throw new Error(`Duplicate event "${name}"`);
          // @ts-expect-error indexed access
          registry.events[name] = {
            schema: state.events[name],
            reactions: new Map(),
          };
        }
      }
      return act<S & { [K in keyof AX]: SX }, E & EX, A & AX>(
        states,
        registry as unknown as Registry<
          S & { [K in keyof AX]: SX },
          E & EX,
          A & AX
        >
      );
    },
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
            retryDelayMs: options?.retryDelayMs ?? 1000,
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
    build: () => new Act<S, E, A>(registry),
    events: registry.events,
  };
  return builder;
}
