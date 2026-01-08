/**
 * @module state-builder
 * @category Builders
 *
 * Fluent interface for defining a strongly-typed state machine using Zod schemas.
 */
import { ZodType } from "zod";
import {
  ActionHandler,
  ActionHandlers,
  GivenHandlers,
  Invariant,
  PatchHandlers,
  Schema,
  Schemas,
  Snapshot,
  State,
  ZodTypes,
} from "./types/index.js";

/* eslint-disable @typescript-eslint/no-empty-object-type */
/**
 * Builder interface for defining a state with event sourcing.
 *
 * Provides a fluent API to configure the initial state, event types,
 * and event handlers (reducers) before moving to action configuration.
 *
 * @template S - State schema type
 *
 * @see {@link state} for usage examples
 * @see {@link ActionBuilder} for action configuration
 */
export type StateBuilder<S extends Schema> = {
  /**
   * Defines the initial state for new state instances.
   *
   * The init function is called when a new stream is created (first event).
   * It can accept initial data or return a default state.
   *
   * @param init - Function returning the initial state
   * @returns A builder with `.emits()` to declare event types
   *
   * @example
   * ```typescript
   * .init(() => ({ count: 0, created: new Date() }))
   * ```
   *
   * @example With initial data
   * ```typescript
   * .init((data) => ({ ...data, createdAt: new Date() }))
   * ```
   */
  init: (init: () => Readonly<S>) => {
    /**
     * Declares the event types that this state can emit.
     *
     * Events represent facts that have happened - they should be named in past tense.
     * Each event is defined with a Zod schema for type safety and runtime validation.
     *
     * @template E - Event schemas type
     * @param events - Object mapping event names to Zod schemas
     * @returns A builder with `.patch()` to define event handlers
     *
     * @example
     * ```typescript
     * .emits({
     *   Incremented: z.object({ amount: z.number() }),
     *   Decremented: z.object({ amount: z.number() }),
     *   Reset: z.object({})
     * })
     * ```
     */
    emits: <E extends Schemas>(
      events: ZodTypes<E>
    ) => {
      /**
       * Defines how each event updates (patches) the state.
       *
       * Patch handlers are reducers - pure functions that take an event and current state,
       * and return the changes to apply. Return partial state objects; unchanged fields
       * are preserved automatically.
       *
       * @param patch - Object mapping event names to patch handler functions
       * @returns An ActionBuilder for defining actions
       *
       * @example
       * ```typescript
       * .patch({
       *   Incremented: (event, state) => ({ count: state.count + event.data.amount }),
       *   Decremented: (event, state) => ({ count: state.count - event.data.amount }),
       *   Reset: () => ({ count: 0 })
       * })
       * ```
       */
      patch: (patch: PatchHandlers<S, E>) => ActionBuilder<S, E, {}>;
    };
  };
};

/**
 * Builder interface for defining actions (commands) on a state.
 *
 * Actions represent user/system intents to modify state. Each action is validated
 * against a schema, can have business rule invariants, and must emit one or more events.
 *
 * @template S - State schema type
 * @template E - Event schemas type
 * @template A - Action schemas type
 *
 * @see {@link state} for complete usage examples
 */
export type ActionBuilder<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = {
  /**
   * Defines an action (command) that can be executed on this state.
   *
   * Actions represent intents to change state - they should be named in imperative form
   * (e.g., "createUser", "incrementCounter", "placeOrder"). Actions are validated against
   * their schema and must emit at least one event.
   *
   * @template K - Action name (string literal type)
   * @template AX - Action payload schema type
   * @param action - The action name (should be unique within this state)
   * @param schema - Zod schema for the action payload
   * @returns An object with `.given()` and `.emit()` for further configuration
   *
   * @example Simple action without invariants
   * ```typescript
   * .on("increment", z.object({ by: z.number() }))
   *   .emit((action) => ["Incremented", { amount: action.by }])
   * ```
   *
   * @example Action with business rules
   * ```typescript
   * .on("withdraw", z.object({ amount: z.number() }))
   *   .given([
   *     (_, snap) => snap.state.balance >= 0 || "Account closed",
   *     (_, snap, action) => snap.state.balance >= action.amount || "Insufficient funds"
   *   ])
   *   .emit((action) => ["Withdrawn", { amount: action.amount }])
   * ```
   *
   * @example Action emitting multiple events
   * ```typescript
   * .on("completeOrder", z.object({ orderId: z.string() }))
   *   .emit((action) => [
   *     ["OrderCompleted", { orderId: action.orderId }],
   *     ["InventoryReserved", { orderId: action.orderId }],
   *     ["PaymentProcessed", { orderId: action.orderId }]
   *   ])
   * ```
   */
  on: <K extends string, AX extends Schema>(
    action: K,
    schema: ZodType<AX>
  ) => {
    /**
     * Adds business rule invariants that must hold before the action can execute.
     *
     * Invariants are checked after loading the current state but before emitting events.
     * Each invariant should return `true` or an error message string. All invariants
     * must pass for the action to succeed.
     *
     * @param rules - Array of invariant functions
     * @returns An object with `.emit()` to finalize the action
     *
     * @example
     * ```typescript
     * .given([
     *   (_, snap) => snap.state.status === "active" || "Must be active",
     *   (target, snap) => snap.state.ownerId === target.actor.id || "Not authorized"
     * ])
     * ```
     */
    given: (rules: Invariant<S>[]) => {
      /**
       * Defines the action handler that emits events.
       *
       * The handler receives the action payload and current state snapshot,
       * and must return one or more events to emit. Events are applied to state
       * via the patch handlers defined earlier.
       *
       * @param handler - Function that returns events to emit
       * @returns The ActionBuilder for chaining more actions
       *
       * @example
       * ```typescript
       * .emit((action, snapshot) => {
       *   const newBalance = snapshot.state.balance + action.amount;
       *   return ["Deposited", { amount: action.amount, newBalance }];
       * })
       * ```
       */
      emit: (
        handler: ActionHandler<S, E, { [P in K]: AX }, K>
      ) => ActionBuilder<S, E, A & { [P in K]: AX }>;
    };
    /**
     * Defines the action handler that emits events.
     *
     * The handler receives the action payload and current state snapshot,
     * and must return one or more events to emit. Return a single event as
     * `["EventName", data]` or multiple events as an array of event tuples.
     *
     * @param handler - Function that returns events to emit
     * @returns The ActionBuilder for chaining more actions
     *
     * @example Single event
     * ```typescript
     * .emit((action) => ["Incremented", { amount: action.by }])
     * ```
     *
     * @example Multiple events
     * ```typescript
     * .emit((action) => [
     *   ["Incremented", { amount: action.by }],
     *   ["LogUpdated", { message: `Incremented by ${action.by}` }]
     * ])
     * ```
     *
     * @example Conditional events
     * ```typescript
     * .emit((action, snapshot) => {
     *   if (snapshot.state.count + action.by >= 100) {
     *     return [
     *       ["Incremented", { amount: action.by }],
     *       ["MilestoneReached", { milestone: 100 }]
     *     ];
     *   }
     *   return ["Incremented", { amount: action.by }];
     * })
     * ```
     */
    emit: (
      handler: ActionHandler<S, E, { [P in K]: AX }, K>
    ) => ActionBuilder<S, E, A & { [P in K]: AX }>;
  };
  /**
   * Defines a snapshotting strategy to optimize state reconstruction.
   *
   * Snapshots store the current state at a point in time, allowing faster state loading
   * by avoiding replaying all events from the beginning. The snap function is called
   * after each event is applied and should return `true` when a snapshot should be taken.
   *
   * @param snap - Predicate function that returns true when a snapshot should be taken
   * @returns The ActionBuilder for chaining
   *
   * @example Snapshot every 10 events
   * ```typescript
   * .snap((snapshot) => snapshot.patches >= 10)
   * ```
   *
   * @example Snapshot based on state size
   * ```typescript
   * .snap((snapshot) => {
   *   const estimatedSize = JSON.stringify(snapshot.state).length;
   *   return estimatedSize > 10000 || snapshot.patches >= 50;
   * })
   * ```
   *
   * @example Time-based snapshotting
   * ```typescript
   * .snap((snapshot) => {
   *   const hoursSinceLastSnapshot = snapshot.patches * 0.1; // Estimate
   *   return hoursSinceLastSnapshot >= 24;
   * })
   * ```
   */
  snap: (snap: (snapshot: Snapshot<S, E>) => boolean) => ActionBuilder<S, E, A>;
  /**
   * Finalizes and builds the state definition.
   *
   * Call this method after defining all actions, invariants, and patches to create
   * the complete State object that can be registered with Act.
   *
   * @returns The complete strongly-typed State definition
   *
   * @example
   * ```typescript
   * const Counter = state("Counter", schema)
   *   .init(() => ({ count: 0 }))
   *   .emits({ Incremented: z.object({ amount: z.number() }) })
   *   .patch({ Incremented: (event, state) => ({ count: state.count + event.data.amount }) })
   *   .on("increment", z.object({ by: z.number() }))
   *     .emit((action) => ["Incremented", { amount: action.by }])
   *   .build(); // Returns State<S, E, A>
   * ```
   */
  build: () => State<S, E, A>;
};

/**
 * Creates a new state definition with event sourcing capabilities.
 *
 * States are the core building blocks of Act. Each state represents a consistency
 * boundary (aggregate) that processes actions, emits events, and maintains its own
 * state through event patches (reducers). States use event sourcing to maintain a
 * complete audit trail and enable time-travel capabilities.
 *
 * The state builder provides a fluent API for defining:
 * 1. Initial state via `.init()`
 * 2. Event types via `.emits()`
 * 3. Event handlers (reducers) via `.patch()`
 * 4. Actions (commands) via `.on()` → `.emit()`
 * 5. Business rules (invariants) via `.given()`
 * 6. Snapshotting strategy via `.snap()`
 *
 * @template S - Zod schema type defining the shape of the state
 * @param name - Unique identifier for this state type (e.g., "Counter", "User", "Order")
 * @param state - Zod schema defining the structure of the state
 * @returns A StateBuilder instance for fluent API configuration
 *
 * @example Basic counter state
 * ```typescript
 * import { state } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const Counter = state("Counter", z.object({ count: z.number() }))
 *   .init(() => ({ count: 0 }))
 *   .emits({
 *     Incremented: z.object({ amount: z.number() })
 *   })
 *   .patch({
 *     Incremented: (event, state) => ({ count: state.count + event.data.amount })
 *   })
 *   .on("increment", z.object({ by: z.number() }))
 *     .emit((action) => ["Incremented", { amount: action.by }])
 *   .build();
 * ```
 *
 * @example State with multiple events and invariants
 * ```typescript
 * const BankAccount = state("BankAccount", z.object({
 *   balance: z.number(),
 *   currency: z.string(),
 *   status: z.enum(["open", "closed"])
 * }))
 *   .init(() => ({ balance: 0, currency: "USD", status: "open" }))
 *   .emits({
 *     Deposited: z.object({ amount: z.number() }),
 *     Withdrawn: z.object({ amount: z.number() }),
 *     Closed: z.object({})
 *   })
 *   .patch({
 *     Deposited: (event, state) => ({ balance: state.balance + event.data.amount }),
 *     Withdrawn: (event, state) => ({ balance: state.balance - event.data.amount }),
 *     Closed: () => ({ status: "closed", balance: 0 })
 *   })
 *   .on("deposit", z.object({ amount: z.number() }))
 *     .given([
 *       (_, snap) => snap.state.status === "open" || "Account must be open"
 *     ])
 *     .emit((action) => ["Deposited", { amount: action.amount }])
 *   .on("withdraw", z.object({ amount: z.number() }))
 *     .given([
 *       (_, snap) => snap.state.status === "open" || "Account must be open",
 *       (_, snap, action) =>
 *         snap.state.balance >= action.amount || "Insufficient funds"
 *     ])
 *     .emit((action) => ["Withdrawn", { amount: action.amount }])
 *   .on("close", z.object({}))
 *     .given([
 *       (_, snap) => snap.state.status === "open" || "Already closed",
 *       (_, snap) => snap.state.balance === 0 || "Balance must be zero"
 *     ])
 *     .emit(() => ["Closed", {}])
 *   .build();
 * ```
 *
 * @example State with snapshotting
 * ```typescript
 * const User = state("User", z.object({
 *   name: z.string(),
 *   email: z.string(),
 *   loginCount: z.number()
 * }))
 *   .init((data) => ({ ...data, loginCount: 0 }))
 *   .emits({
 *     UserCreated: z.object({ name: z.string(), email: z.string() }),
 *     UserLoggedIn: z.object({})
 *   })
 *   .patch({
 *     UserCreated: (event) => event.data,
 *     UserLoggedIn: (_, state) => ({ loginCount: state.loginCount + 1 })
 *   })
 *   .on("createUser", z.object({ name: z.string(), email: z.string() }))
 *     .emit((action) => ["UserCreated", action])
 *   .on("login", z.object({}))
 *     .emit(() => ["UserLoggedIn", {}])
 *   .snap((snap) => snap.patches >= 10) // Snapshot every 10 events
 *   .build();
 * ```
 *
 * @see {@link StateBuilder} for available builder methods
 * @see {@link ActionBuilder} for action configuration methods
 * @see {@link https://rotorsoft.github.io/act-root/docs/intro | Getting Started Guide}
 * @see {@link https://rotorsoft.github.io/act-root/docs/examples/calculator | Calculator Example}
 */
export function state<S extends Schema>(
  name: string,
  state: ZodType<S>
): StateBuilder<S> {
  return {
    init(init: () => Readonly<S>) {
      return {
        emits<E extends Schema>(events: ZodTypes<E>) {
          return {
            patch(patch: PatchHandlers<S, E>) {
              return action_builder<S, E, {}>({
                events,
                actions: {},
                state,
                name,
                init,
                patch,
                on: {},
              });
            },
          };
        },
      };
    },
  };
}

function action_builder<S extends Schema, E extends Schemas, A extends Schemas>(
  state: State<S, E, A>
): ActionBuilder<S, E, A> {
  return {
    on<K extends string, AX extends Schema>(action: K, schema: ZodType<AX>) {
      if (action in state.actions)
        throw new Error(`Duplicate action "${action}"`);

      type NewA = A & { [P in K]: AX };
      const actions = { ...state.actions, [action]: schema } as ZodTypes<NewA>;
      const on = { ...state.on } as ActionHandlers<S, E, NewA>;
      const _given = { ...state.given } as GivenHandlers<S, NewA>;

      function given(rules: Invariant<S>[]) {
        _given[action] = rules;
        return { emit };
      }

      function emit(handler: ActionHandler<S, E, NewA, K>) {
        on[action] = handler;
        return action_builder<S, E, NewA>({
          ...state,
          actions,
          on,
          given: _given,
        });
      }

      return { given, emit };
    },

    snap(snap: (snapshot: Snapshot<S, E>) => boolean) {
      return action_builder<S, E, A>({ ...state, snap });
    },

    build(): State<S, E, A> {
      return state;
    },
  };
}
