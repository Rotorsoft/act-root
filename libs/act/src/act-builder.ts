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
 * Fluent builder interface for composing event-sourced applications.
 *
 * Provides a chainable API for:
 * - Registering states via `.with()`
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
> = {
  /**
   * Registers a state definition with the builder.
   *
   * States define aggregates that process actions and emit events. Each state
   * registration adds its actions and events to the orchestrator's registry.
   * State names, action names, and event names must be unique across the application.
   *
   * @template SX - State schema type
   * @template EX - Event schemas type for this state
   * @template AX - Action schemas type for this state
   * @param state - The state definition to register
   * @returns The builder with updated type information for chaining
   *
   * @throws {Error} If a state with duplicate action or event names is registered
   *
   * @example Register single state
   * ```typescript
   * const app = act()
   *   .with(Counter)
   *   .build();
   * ```
   *
   * @example Register multiple states
   * ```typescript
   * const app = act()
   *   .with(User)
   *   .with(Order)
   *   .with(Inventory)
   *   .build();
   * ```
   */
  with: <SX extends Schema, EX extends Schemas, AX extends Schemas>(
    state: State<SX, EX, AX>
  ) => ActBuilder<S & { [K in keyof AX]: SX }, E & EX, A & AX>;
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
     *
     * @example Side effect only (void)
     * ```typescript
     * .on("UserCreated")
     *   .do(async (event) => {
     *     await analytics.track("user_created", event.data);
     *   })
     *   .void()
     * ```
     *
     * @example Trigger another action
     * ```typescript
     * .on("OrderPlaced")
     *   .do(async (event) => {
     *     return ["reduceStock", { amount: event.data.items.length }];
     *   })
     *   .to("inventory-1")
     * ```
     *
     * @example With retry configuration
     * ```typescript
     * .on("PaymentProcessed")
     *   .do(async (event) => {
     *     await externalAPI.notify(event.data);
     *   }, {
     *     blockOnError: false,  // Don't block on failure
     *     maxRetries: 5         // Retry up to 5 times
     *   })
     *   .void()
     * ```
     */
    do: (
      handler: ReactionHandler<E, K>,
      options?: Partial<ReactionOptions>
    ) => ActBuilder<S, E, A> & {
      /**
       * Routes the reaction to a specific target stream.
       *
       * Use this when the reaction triggers an action on a specific state instance.
       * You can provide either a static stream name (string) or a resolver function
       * that dynamically determines the target based on the event.
       *
       * @param resolver - Target stream name (string) or resolver function
       * @returns The builder for chaining
       *
       * @example Static target stream
       * ```typescript
       * .on("OrderPlaced")
       *   .do(async (event) => ["reduceStock", { amount: 10 }])
       *   .to("inventory-main")
       * ```
       *
       * @example Dynamic target based on event data
       * ```typescript
       * .on("OrderPlaced")
       *   .do(async (event) => ["reduceStock", { amount: 10 }])
       *   .to((event) => ({
       *     target: `inventory-${event.data.warehouseId}`
       *   }))
       * ```
       *
       * @example Source and target routing
       * ```typescript
       * .on("UserLoggedIn")
       *   .do(async (event) => ["incrementCount", {}])
       *   .to(({ stream }) => ({
       *     source: stream,           // React to events from this user stream
       *     target: `stats-${stream}` // Update corresponding stats stream
       *   }))
       * ```
       */
      to: (resolver: ReactionResolver<E, K> | string) => ActBuilder<S, E, A>;
      /**
       * Marks the reaction as void (side-effect only, no target stream).
       *
       * Use this when the reaction doesn't trigger any actions - it only performs
       * side effects like logging, sending notifications, or updating external systems.
       *
       * @returns The builder for chaining
       *
       * @example
       * ```typescript
       * .on("UserCreated")
       *   .do(async (event) => {
       *     await sendEmail(event.data.email, "Welcome!");
       *     await logger.info("User created", event.data);
       *   })
       *   .void()  // No target stream
       * ```
       */
      void: () => ActBuilder<S, E, A>;
    };
  };
  /**
   * Builds and returns the Act orchestrator instance.
   *
   * This finalizes the builder configuration and creates the orchestrator that
   * can execute actions, load state, and process reactions.
   *
   * @param drainLimit - Deprecated parameter, no longer used
   * @returns The Act orchestrator instance
   *
   * @example
   * ```typescript
   * const app = act()
   *   .with(Counter)
   *   .with(User)
   *   .on("UserCreated")
   *     .do(sendWelcomeEmail)
   *     .void()
   *   .build();
   *
   * // Now use the app
   * await app.do("createUser", target, payload);
   * await app.drain();
   * ```
   *
   * @see {@link Act} for available orchestrator methods
   */
  build: (drainLimit?: number) => Act<S, E, A>;
  /**
   * The registered event schemas and their reaction maps.
   *
   * This is an internal registry maintained by the builder. Generally, you don't
   * need to access this directly.
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
 * Use the fluent API to register states with `.with()`, define event reactions with `.on()`,
 * and build the orchestrator with `.build()`.
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
 *
 * // Execute action
 * await app.do("increment",
 *   { stream: "counter1", actor: { id: "user1", name: "Alice" } },
 *   { by: 5 }
 * );
 *
 * // Load current state
 * const snapshot = await app.load(Counter, "counter1");
 * console.log(snapshot.state.count); // 5
 * ```
 *
 * @example Application with reactions
 * ```typescript
 * const User = state("User", z.object({ name: z.string(), email: z.string() }))
 *   .init((data) => data)
 *   .emits({ UserCreated: z.object({ name: z.string(), email: z.string() }) })
 *   .patch({ UserCreated: (event) => event.data })
 *   .on("createUser", z.object({ name: z.string(), email: z.string() }))
 *     .emit((action) => ["UserCreated", action])
 *   .build();
 *
 * const app = act()
 *   .with(User)
 *   .on("UserCreated")
 *     .do(async (event) => {
 *       // Send welcome email
 *       await sendEmail(event.data.email, "Welcome!");
 *       logger.info(`Sent welcome email to ${event.data.email}`);
 *     })
 *     .void() // No target stream, just side effects
 *   .build();
 *
 * // Create user (triggers email sending via reaction)
 * await app.do("createUser",
 *   { stream: "user-123", actor: { id: "admin", name: "Admin" } },
 *   { name: "Alice", email: "alice@example.com" }
 * );
 *
 * // Process reactions
 * await app.drain();
 * ```
 *
 * @example Multi-state application with event correlation
 * ```typescript
 * const Order = state("Order", z.object({ items: z.array(z.string()), total: z.number() }))
 *   .init((data) => data)
 *   .emits({ OrderPlaced: z.object({ items: z.array(z.string()), total: z.number() }) })
 *   .patch({ OrderPlaced: (event) => event.data })
 *   .on("placeOrder", z.object({ items: z.array(z.string()), total: z.number() }))
 *     .emit((action) => ["OrderPlaced", action])
 *   .build();
 *
 * const Inventory = state("Inventory", z.object({ stock: z.number() }))
 *   .init(() => ({ stock: 100 }))
 *   .emits({ StockReduced: z.object({ amount: z.number() }) })
 *   .patch({ StockReduced: (event, state) => ({ stock: state.stock - event.data.amount }) })
 *   .on("reduceStock", z.object({ amount: z.number() }))
 *     .emit((action) => ["StockReduced", { amount: action.amount }])
 *   .build();
 *
 * const app = act()
 *   .with(Order)
 *   .with(Inventory)
 *   .on("OrderPlaced")
 *     .do(async (event) => {
 *       // Reduce inventory for each item
 *       return ["reduceStock", { amount: event.data.items.length }];
 *     })
 *     .to("inventory-1") // Target specific inventory stream
 *   .build();
 *
 * await app.do("placeOrder",
 *   { stream: "order-1", actor: { id: "user1", name: "Alice" } },
 *   { items: ["item1", "item2"], total: 100 }
 * );
 *
 * // Process reaction (reduces inventory)
 * await app.drain();
 * ```
 *
 * @example Partial state definitions (same name, merged via .with())
 * ```typescript
 * const TicketCreation = state("Ticket", TicketSchema)
 *   .init(() => initialTicket)
 *   .emits({ TicketOpened: ..., TicketClosed: ... })
 *   .patch({ TicketOpened: ..., TicketClosed: ... })
 *   .on("OpenTicket", ...).emit(...)
 *   .on("CloseTicket", ...).emit(...)
 *   .build();
 *
 * const TicketMessaging = state("Ticket", TicketSchema)
 *   .init(() => initialTicket)
 *   .emits({ MessageAdded: ... })
 *   .patch({ MessageAdded: ... })
 *   .on("AddMessage", ...).emit(...)
 *   .build();
 *
 * // Partials with same name are merged automatically
 * const app = act()
 *   .with(TicketCreation)
 *   .with(TicketMessaging)
 *   .build();
 * ```
 *
 * @see {@link ActBuilder} for available builder methods
 * @see {@link Act} for orchestrator API methods
 * @see {@link state} for defining states
 * @see {@link https://rotorsoft.github.io/act-root/docs/intro | Documentation}
 */
export function act<
  // @ts-expect-error empty schema
  S extends SchemaRegister<A> = {},
  E extends Schemas = {},
  A extends Schemas = {},
>(
  states: Map<string, State<any, any, any>> = new Map(),
  registry: Registry<S, E, A> = {
    actions: {} as any,
    events: {} as any,
  }
): ActBuilder<S, E, A> {
  const builder: ActBuilder<S, E, A> = {
    /**
     * Adds a state to the builder. When a state with the same name is already
     * registered, merges the new partial's actions, events, patches, and handlers
     * into the existing state (errors on duplicate action/event names).
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
      if (states.has(state.name)) {
        // MERGE: same state name - combine events, actions, patches, handlers
        const existing = states.get(state.name)!;
        for (const name of Object.keys(state.actions)) {
          if (registry.actions[name])
            throw new Error(`Duplicate action "${name}"`);
        }
        for (const name of Object.keys(state.events)) {
          if (registry.events[name])
            throw new Error(`Duplicate event "${name}"`);
        }
        const merged = {
          ...existing,
          events: { ...existing.events, ...state.events },
          actions: { ...existing.actions, ...state.actions },
          patch: { ...existing.patch, ...state.patch },
          on: { ...existing.on, ...state.on },
          given: { ...existing.given, ...state.given },
          snap: state.snap || existing.snap,
        };
        states.set(state.name, merged);
        // Update ALL action→state pointers to the merged object
        for (const name of Object.keys(merged.actions)) {
          // @ts-expect-error indexed access
          registry.actions[name] = merged;
        }
        for (const name of Object.keys(state.events)) {
          // @ts-expect-error indexed access
          registry.events[name] = {
            schema: state.events[name],
            reactions: new Map(),
          };
        }
      } else {
        // NEW: register state for the first time
        states.set(state.name, state as State<any, any, any>);
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
    build: () => new Act<S, E, A>(registry, states),
    events: registry.events,
  };
  return builder;
}
