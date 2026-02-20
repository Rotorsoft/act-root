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
export type StateBuilder<S extends Schema, N extends string = string> = {
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
     * @returns An ActionBuilder (with optional `.patch()` to override specific reducers)
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
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} avoids string index signature that Record<string, never> would add, keeping keyof A precise
    ) => ActionBuilder<S, E, {}, N> & {
      /**
       * Overrides specific event reducers. Events without a custom patch
       * default to passthrough: `({ data }) => data` (event data merges
       * into state).
       *
       * @param patch - Partial map of event names to patch handler functions
       * @returns An ActionBuilder for defining actions
       *
       * @example Only override the events that need custom logic
       * ```typescript
       * .emits({ TicketOpened, TicketClosed, TicketResolved })
       * .patch({
       *   TicketOpened: ({ data }) => {
       *     const { message, messageId, userId, ...other } = data;
       *     return { ...other, userId, messages: { [messageId]: { ... } } };
       *   },
       * })
       * // TicketClosed and TicketResolved use passthrough
       * ```
       */
      patch: (
        patch: Partial<PatchHandlers<S, E>>
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} avoids string index signature that Record<string, never> would add, keeping keyof A precise
      ) => ActionBuilder<S, E, {}, N>;
    };
  };
};

/** Helper: a single-key record mapping a state name to its Zod schema. */
type StateEntry<K extends string = string, S extends Schema = Schema> = {
  [P in K]: ZodType<S>;
};

/** Helper: a single-key record mapping an action name to its Zod schema. */
type ActionEntry<K extends string = string, AX extends Schema = Schema> = {
  [P in K]: ZodType<AX>;
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
  N extends string = string,
> = {
  /**
   * Defines an action (command) that can be executed on this state.
   *
   * Actions represent intents to change state - they should be named in imperative form
   * (e.g., "CreateUser", "IncrementCounter", "PlaceOrder"). Actions are validated against
   * their schema and must emit at least one event.
   *
   * Pass a `{ ActionName: schema }` record — use shorthand `{ ActionName }`
   * when the variable name matches the action name. The key becomes the
   * action name, the value the Zod schema.
   *
   * @template K - Action name (string literal type)
   * @template AX - Action payload schema type
   * @param entry - Single-key record `{ ActionName: schema }`
   * @returns An object with `.given()` and `.emit()` for further configuration
   *
   * @example Simple action without invariants
   * ```typescript
   * .on({ increment: z.object({ by: z.number() }) })
   *   .emit((action) => ["Incremented", { amount: action.by }])
   * ```
   *
   * @example Action with business rules
   * ```typescript
   * .on({ withdraw: z.object({ amount: z.number() }) })
   *   .given([
   *     (_, snap) => snap.state.balance >= 0 || "Account closed",
   *     (_, snap, action) => snap.state.balance >= action.amount || "Insufficient funds"
   *   ])
   *   .emit((action) => ["Withdrawn", { amount: action.amount }])
   * ```
   *
   * @example Action with shorthand (variable name matches action name)
   * ```typescript
   * const OpenTicket = z.object({ title: z.string() });
   * .on({ OpenTicket })
   *   .emit((action) => ["TicketOpened", { title: action.title }])
   * ```
   */
  on: <K extends string, AX extends Schema>(
    entry: ActionEntry<K, AX>
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
       * Pass a string event name for passthrough: the action payload becomes
       * the event data directly.
       *
       * @param handler - Function that returns events to emit, or event name string for passthrough
       * @returns The ActionBuilder for chaining more actions
       *
       * @example Custom handler
       * ```typescript
       * .emit((action, snapshot) => {
       *   const newBalance = snapshot.state.balance + action.amount;
       *   return ["Deposited", { amount: action.amount, newBalance }];
       * })
       * ```
       *
       * @example Passthrough (action payload = event data)
       * ```typescript
       * .emit("TicketAssigned")
       * ```
       */
      emit: (
        handler: ActionHandler<S, E, { [P in K]: AX }, K> | (keyof E & string)
      ) => ActionBuilder<S, E, A & { [P in K]: AX }, N>;
    };
    /**
     * Defines the action handler that emits events.
     *
     * The handler receives the action payload and current state snapshot,
     * and must return one or more events to emit. Return a single event as
     * `["EventName", data]` or multiple events as an array of event tuples.
     *
     * Pass a string event name for passthrough: the action payload becomes
     * the event data directly.
     *
     * @param handler - Function that returns events to emit, or event name string for passthrough
     * @returns The ActionBuilder for chaining more actions
     *
     * @example Passthrough (action payload = event data)
     * ```typescript
     * .emit("Incremented")
     * ```
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
     */
    emit: (
      handler: ActionHandler<S, E, { [P in K]: AX }, K> | (keyof E & string)
    ) => ActionBuilder<S, E, A & { [P in K]: AX }, N>;
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
  snap: (
    snap: (snapshot: Snapshot<S, E>) => boolean
  ) => ActionBuilder<S, E, A, N>;
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
   * const Counter = state({ Counter: schema })
   *   .init(() => ({ count: 0 }))
   *   .emits({ Incremented: z.object({ amount: z.number() }) })
   *   .patch({ Incremented: ({ data }, state) => ({ count: state.count + data.amount }) })
   *   .on({ increment: z.object({ by: z.number() }) })
   *     .emit((action) => ["Incremented", { amount: action.by }])
   *   .build(); // Returns State<S, E, A, N>
   * ```
   */
  build: () => State<S, E, A, N>;
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
 * 2. Event types via `.emits()` — all events default to passthrough (`({ data }) => data`)
 * 3. Custom event reducers via `.patch()` (optional — only for events that need custom logic)
 * 4. Actions (commands) via `.on()` → `.emit()` — pass an event name string for passthrough
 * 5. Business rules (invariants) via `.given()`
 * 6. Snapshotting strategy via `.snap()`
 *
 * @template S - Zod schema type defining the shape of the state
 * @param entry - Single-key record mapping state name to Zod schema (e.g., `{ Counter: z.object({ count: z.number() }) }`)
 * @returns A StateBuilder instance for fluent API configuration
 *
 * @example Basic counter state (with custom patch)
 * ```typescript
 * import { state } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const Counter = state({ Counter: z.object({ count: z.number() }) })
 *   .init(() => ({ count: 0 }))
 *   .emits({
 *     Incremented: z.object({ amount: z.number() })
 *   })
 *   .patch({  // optional — only for events needing custom reducers
 *     Incremented: ({ data }, state) => ({ count: state.count + data.amount })
 *   })
 *   .on({ increment: z.object({ by: z.number() }) })
 *     .emit((action) => ["Incremented", { amount: action.by }])
 *   .build();
 * ```
 *
 * @example Passthrough state (no custom patch or emit needed)
 * ```typescript
 * const DigitBoard = state({ DigitBoard: z.object({ digit: z.string() }) })
 *   .init(() => ({ digit: "" }))
 *   .emits({ DigitCounted: z.object({ digit: z.string() }) })
 *   // no .patch() — passthrough is the default (event data merges into state)
 *   .on({ CountDigit: z.object({ digit: z.string() }) })
 *     .emit("DigitCounted")  // string passthrough — action payload becomes event data
 *   .build();
 * ```
 *
 * @example State with multiple events and invariants
 * ```typescript
 * const BankAccount = state({ BankAccount: z.object({
 *   balance: z.number(),
 *   currency: z.string(),
 *   status: z.enum(["open", "closed"])
 * }) })
 *   .init(() => ({ balance: 0, currency: "USD", status: "open" }))
 *   .emits({
 *     Deposited: z.object({ amount: z.number() }),
 *     Withdrawn: z.object({ amount: z.number() }),
 *     Closed: z.object({})
 *   })
 *   .patch({  // only override events needing custom logic
 *     Deposited: ({ data }, state) => ({ balance: state.balance + data.amount }),
 *     Withdrawn: ({ data }, state) => ({ balance: state.balance - data.amount }),
 *     Closed: () => ({ status: "closed", balance: 0 })
 *   })
 *   .on({ deposit: z.object({ amount: z.number() }) })
 *     .given([
 *       (_, snap) => snap.state.status === "open" || "Account must be open"
 *     ])
 *     .emit("Deposited")  // passthrough — action payload { amount } becomes event data
 *   .on({ withdraw: z.object({ amount: z.number() }) })
 *     .given([
 *       (_, snap) => snap.state.status === "open" || "Account must be open",
 *       (_, snap, action) =>
 *         snap.state.balance >= action.amount || "Insufficient funds"
 *     ])
 *     .emit("Withdrawn")
 *   .on({ close: z.object({}) })
 *     .given([
 *       (_, snap) => snap.state.status === "open" || "Already closed",
 *       (_, snap) => snap.state.balance === 0 || "Balance must be zero"
 *     ])
 *     .emit("Closed")
 *   .build();
 * ```
 *
 * @example State with snapshotting
 * ```typescript
 * const User = state({ User: z.object({
 *   name: z.string(),
 *   email: z.string(),
 *   loginCount: z.number()
 * }) })
 *   .init((data) => ({ ...data, loginCount: 0 }))
 *   .emits({
 *     UserCreated: z.object({ name: z.string(), email: z.string() }),
 *     UserLoggedIn: z.object({})
 *   })
 *   .patch({  // only override events needing custom logic
 *     UserLoggedIn: (_, state) => ({ loginCount: state.loginCount + 1 })
 *   })
 *   // UserCreated uses passthrough — event data merges into state
 *   .on({ createUser: z.object({ name: z.string(), email: z.string() }) })
 *     .emit("UserCreated")  // passthrough
 *   .on({ login: z.object({}) })
 *     .emit("UserLoggedIn")
 *   .snap((snap) => snap.patches >= 10) // Snapshot every 10 events
 *   .build();
 * ```
 *
 * @see {@link StateBuilder} for available builder methods
 * @see {@link ActionBuilder} for action configuration methods
 * @see {@link https://rotorsoft.github.io/act-root/docs/intro | Getting Started Guide}
 * @see {@link https://rotorsoft.github.io/act-root/docs/examples/calculator | Calculator Example}
 */
export function state<N extends string, S extends Schema>(
  entry: StateEntry<N, S>
): StateBuilder<S, N> {
  const keys = Object.keys(entry);
  if (keys.length !== 1) throw new Error("state() requires exactly one key");
  const name = keys[0] as N;
  const stateSchema = (entry as Record<string, ZodType<S>>)[name];
  return {
    init(init: () => Readonly<S>) {
      return {
        emits<E extends Schema>(events: ZodTypes<E>) {
          // Default passthrough patches: event data merges into state
          const defaultPatch = Object.fromEntries(
            Object.keys(events).map((k) => [
              k,
              ({ data }: { data: any }) => data,
            ])
          ) as unknown as PatchHandlers<S, E>;

          // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} avoids string index signature
          const builder = action_builder<S, E, {}, N>({
            events,
            actions: {},
            state: stateSchema,
            name,
            init,
            patch: defaultPatch,
            on: {},
          });

          return Object.assign(builder, {
            patch(customPatch: Partial<PatchHandlers<S, E>>) {
              // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} avoids string index signature
              return action_builder<S, E, {}, N>({
                events,
                actions: {},
                state: stateSchema,
                name,
                init,
                patch: { ...defaultPatch, ...customPatch },
                on: {},
              });
            },
          });
        },
      };
    },
  };
}

function action_builder<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
  N extends string = string,
>(state: State<S, E, A, N>): ActionBuilder<S, E, A, N> {
  return {
    on<K extends string, AX extends Schema>(entry: ActionEntry<K, AX>) {
      const keys = Object.keys(entry);
      if (keys.length !== 1) throw new Error(".on() requires exactly one key");
      const action = keys[0] as K;
      const schema = entry[action];

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

      function emit(
        handler: ActionHandler<S, E, NewA, K> | (keyof E & string)
      ) {
        if (typeof handler === "string") {
          const eventName = handler;
          on[action] = ((payload: any) => [eventName, payload]) as any;
        } else {
          on[action] = handler;
        }
        return action_builder<S, E, NewA, N>({
          ...state,
          actions,
          on,
          given: _given,
        });
      }

      return { given, emit };
    },

    snap(snap: (snapshot: Snapshot<S, E>) => boolean) {
      return action_builder<S, E, A, N>({ ...state, snap });
    },

    build(): State<S, E, A, N> {
      return state;
    },
  };
}
