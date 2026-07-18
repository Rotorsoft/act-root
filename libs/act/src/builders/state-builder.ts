/**
 * @module state-builder
 * @category Builders
 *
 * Fluent interface for defining a strongly-typed state machine using Zod schemas.
 */
import type { ZodType } from "zod";
import {
  type AutoclosePolicy,
  compile_autoclose_policy,
  policy_keep_days,
  policy_min_after_days,
  resolveActionConfig,
} from "../internal/index.js";
import type {
  ActionHandler,
  ActionOptions,
  Actor,
  AutocloseArchiver,
  AutoclosePredicate,
  Committed,
  GivenHandlers,
  Invariant,
  PassthroughPatchHandler,
  PatchHandlers,
  Schema,
  Schemas,
  Snapshot,
  State,
  ZodTypes,
} from "../types/index.js";

/**
 * Builder interface for defining a state with event sourcing.
 *
 * Provides a fluent API to configure the initial state, event types,
 * and event handlers (reducers) before moving to action configuration.
 *
 * @template TState - State schema type
 * @template TName - State name literal type
 *
 * @see {@link state} for usage examples
 * @see {@link ActionBuilder} for action configuration
 */
export type StateBuilder<
  TState extends Schema,
  TName extends string = string,
> = {
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
  init: (init: () => Readonly<TState>) => {
    /**
     * Declares the event types that this state can emit.
     *
     * Events represent facts that have happened - they should be named in past tense.
     * Each event is defined with a Zod schema for type safety and runtime validation.
     *
     * @template TEvents - Event schemas type
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
    emits: <TEvents extends Schemas>(
      events: ZodTypes<TEvents>
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} avoids string index signature that Record<string, never> would add, keeping keyof A precise
    ) => ActionBuilder<TState, TEvents, {}, TName> & {
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
        patch: Partial<PatchHandlers<TState, TEvents>>
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} avoids string index signature that Record<string, never> would add, keeping keyof A precise
      ) => ActionBuilder<TState, TEvents, {}, TName>;
    };
  };
};

/** Helper: a single-key record mapping a state name to its Zod schema. */
type StateEntry<
  TKey extends string = string,
  TState extends Schema = Schema,
> = {
  [P in TKey]: ZodType<TState>;
};

/** Helper: a single-key record mapping an action name to its Zod schema. */
type ActionEntry<
  TKey extends string = string,
  TNewActions extends Schema = Schema,
> = {
  [P in TKey]: ZodType<TNewActions>;
};

/**
 * Builder interface for defining actions (commands) on a state.
 *
 * Actions represent user/system intents to modify state. Each action is validated
 * against a schema, can have business rule invariants, and must emit one or more events.
 *
 * @template TState - State schema type
 * @template TEvents - Event schemas type
 * @template TActions - Action schemas type
 * @template TName - State name literal type
 * @template TSnap - `true` once `.snap(...)` has been called. Gates the
 *   `.autocloses({ keep })` rolling-window option — a windowed close is
 *   meaningless without snapshots, so `keep` only typechecks after
 *   `.snap` in the chain.
 *
 * @see {@link state} for complete usage examples
 */
export type ActionBuilder<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string = string,
  TSnap extends boolean = false,
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
   * Pass an optional second argument to declare a per-action retry
   * policy — the orchestrator retries this action on
   * {@link ConcurrencyError} up to `maxRetries` extra times, applying
   * `backoff` between attempts when set. Omit the argument to keep the
   * current single-attempt behavior (`ConcurrencyError` surfaces on
   * first conflict).
   *
   * @template TKey - Action name (string literal type)
   * @template TNewActions - Action payload schema type
   * @param entry - Single-key record `{ ActionName: schema }`
   * @param options - Optional per-action retry policy
   *   ({@link ActionOptions}).
   * @returns An object with `.given()` and `.emit()` for further configuration
   *
   * @example Simple action without invariants
   * ```typescript
   * .on({ increment: z.object({ by: z.number() }) })
   *   .emit((action) => ["Incremented", { amount: action.by }])
   * ```
   *
   * @example Hot-stream action with retry + jittered exponential backoff
   * ```typescript
   * .on(
   *   { transfer: z.object({ amount: z.number() }) },
   *   {
   *     maxRetries: 5,
   *     backoff: { strategy: "exponential", baseMs: 10, maxMs: 200, jitter: true },
   *   }
   * )
   *   .emit((action) => ["Transferred", { amount: action.amount }])
   * ```
   *
   * @example Action with business rules
   * ```typescript
   * .on({ withdraw: z.object({ amount: z.number() }) })
   *   .given([
   *     { description: "Account must be open", valid: (state) => state.status === "open" },
   *     { description: "Funds must be available", valid: (state) => state.balance > 0 }
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
  on: <TKey extends string, TNewActions extends Schema>(
    entry: ActionEntry<TKey, TNewActions>,
    options?: ActionOptions
  ) => {
    /**
     * Adds business rule invariants that must hold before the action can execute.
     *
     * Invariants are checked after loading the current state but before emitting
     * events. Each invariant pairs a `description` with a `valid(state, actor?)`
     * predicate — when a predicate returns `false`, the action throws
     * `InvariantError` carrying the description. All invariants must pass for
     * the action to succeed.
     *
     * @param rules - Array of {@link Invariant} objects (`{ description, valid }`)
     * @returns An object with `.emit()` to finalize the action
     *
     * @example
     * ```typescript
     * .given([
     *   { description: "Must be active", valid: (state) => state.status === "active" },
     *   { description: "Must be the owner", valid: (state, actor) => state.ownerId === actor?.id }
     * ])
     * ```
     */
    given: (rules: Invariant<TState>[]) => {
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
      emit: {
        /** Custom handler — receives `(action, snapshot)` and returns one
         *  or more `[EventName, data]` tuples (or `undefined`). */
        (
          handler: ActionHandler<
            TState,
            TEvents,
            { [P in TKey]: TNewActions },
            TKey
          >
        ): ActionBuilder<
          TState,
          TEvents,
          TActions & { [P in TKey]: TNewActions },
          TName,
          TSnap
        >;
        /** Passthrough — the action payload becomes the event data
         *  directly. Must reference an event declared in `.emits()`. */
        (
          event_name: keyof TEvents & string
        ): ActionBuilder<
          TState,
          TEvents,
          TActions & { [P in TKey]: TNewActions },
          TName,
          TSnap
        >;
      };
    };
    /**
     * Defines the action handler that emits events. Same two overloads as
     * the post-`.given()` form above:
     *
     * - **Function** — receives `(action, snapshot)` and returns one or
     *   more `[EventName, data]` tuples (or `undefined`).
     * - **String** — passthrough: the action payload becomes the event
     *   data directly. Must reference an event declared in `.emits()`.
     *
     * The two overloads are kept separate (rather than merged into a
     * `handler | string` union) so that TS contextual typing of the
     * function alternative isn't degraded by considering the string
     * branch — under the union form `TState` could collapse to its
     * `Schema` constraint inside the callback.
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
    emit: {
      (
        handler: ActionHandler<
          TState,
          TEvents,
          { [P in TKey]: TNewActions },
          TKey
        >
      ): ActionBuilder<
        TState,
        TEvents,
        TActions & { [P in TKey]: TNewActions },
        TName,
        TSnap
      >;
      (
        event_name: keyof TEvents & string
      ): ActionBuilder<
        TState,
        TEvents,
        TActions & { [P in TKey]: TNewActions },
        TName,
        TSnap
      >;
    };
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
    snap: (snapshot: Snapshot<TState, TEvents>) => boolean
  ) => ActionBuilder<TState, TEvents, TActions, TName, true>;
  /**
   * Declares the disclosure predicate for `sensitive(...)`-marked event
   * fields. Gates external reads: returning `true` allows the actor to see
   * plaintext on the event; returning `false` substitutes `"[REDACTED]"`.
   * When absent, the framework default-denies on every external read —
   * fail-safe.
   *
   * One predicate per state. A second `.discloses(...)` call replaces the
   * first (same shape as snapshots being state-level, not per-event).
   *
   * The predicate receives the full event including merged PII so it can
   * branch on the payload itself (e.g.
   * `event.data.ownerId === actor.id`). Reducers, projections, and
   * reactions are unaffected — they follow separate visibility rules
   * documented in #855.
   *
   * @param disclose - Predicate `(event, actor) => boolean`. `true` =
   *   plaintext, `false` = `"[REDACTED]"` substitution.
   * @returns The ActionBuilder for chaining.
   *
   * @example Owner-or-admin disclosure
   * ```typescript
   * state({ User: userSchema })
   *   .init(() => ({ ... }))
   *   .emits({ UserRegistered: z.object({ email: sensitive(z.string()) }) })
   *   .discloses((event, actor) =>
   *     actor.id === event.stream || actor.roles?.includes("admin"))
   * ```
   */
  discloses: (
    disclose: (
      event: Committed<TEvents, keyof TEvents & string>,
      actor: Actor
    ) => boolean
  ) => ActionBuilder<TState, TEvents, TActions, TName, TSnap>;
  /**
   * Declares the online close predicate for this state. The
   * orchestrator's autoclose cycle iterates the state's streams once
   * per tick and calls the predicate per candidate; truthy results are
   * scheduled for atomic truncate-and-seed via `Store.truncate` on the
   * next batch.
   *
   * One predicate per state. A second `.autocloses(...)` call replaces
   * the first (same shape as `.snap` / `.discloses` — state-level, not
   * per-event). Absent → the state opts out of online close entirely;
   * the cycle skips it and pays zero per-tick cost for it.
   *
   * Pass a declarative {@link AutoclosePolicy} object literal covering the
   * three operational pressure points (`after`, `is`, `reaches`). Top-level
   * fields combine with AND; an optional `or: {...}` block opens an
   * alternative OR path. Validated via Zod at build time; misconfiguration
   * throws before `act().build()` completes.
   *
   * Under the hood this compiles to a synthesized reaction (#1090) that runs
   * on a per-aggregate synthetic stream: it defers to `head.created + the
   * policy's min after` while the cooldown holds and closes the stream once
   * the policy matches. There is no background sweep.
   *
   * **The function-predicate form was removed (#1090).** `.autocloses` no
   * longer accepts `(stream, head, count) => boolean`; an opaque predicate has
   * no derivable due-time or terminal event to react to. For conditions the
   * declarative form can't express, call `app.close(...)` from your own logic.
   *
   * @param policy The declarative {@link AutoclosePolicy} bag.
   * @returns The ActionBuilder for chaining.
   *
   * @example Declarative — cooldown after terminal (a Ticket closes
   *   90 days after resolution).
   * ```typescript
   * .autocloses({ is: "TicketResolved", after: { days: 90 } })
   * ```
   *
   * @example Declarative — multi-terminal (an Order closes on any of
   *   three terminal events, no cooldown).
   * ```typescript
   * .autocloses({ is: ["Shipped", "Delivered", "Cancelled"] })
   * ```
   *
   * @example Declarative — time-only retention (a Session closes
   *   after 24h regardless of head event).
   * ```typescript
   * .autocloses({ after: { days: 1 } })
   * ```
   *
   * @example Declarative — pure cardinality cap.
   * ```typescript
   * .autocloses({ reaches: 10_000 })
   * ```
   *
   * @example Declarative — primary cooldown + safety-net backstop.
   * ```typescript
   * .autocloses({
   *   is: "TicketResolved",     // primary trigger
   *   after: { days: 90 },      // AND aged 90 days
   *   or: { reaches: 10_000 },  // OR cardinality safety net
   * })
   * ```
   *
   * @example Declarative — pure OR (only backstops, no primary
   *   cooldown).
   * ```typescript
   * .autocloses({ or: { is: "TicketResolved", reaches: 10_000 } })
   * ```
   *
   * @example Rolling window — keep the last 180 days of real events on a
   *   live stream (requires `.snap(...)` earlier in the chain; `keep`
   *   won't typecheck without it). Each eligible cycle prunes the prefix
   *   below the closest safe snapshot older than `now − keep`.
   * ```typescript
   * .snap((s) => s.patches >= 100)
   * .autocloses({ keep: { days: 180 } })
   * ```
   *
   * @example Terminate AND prune — close 90 days after resolution,
   *   meanwhile keep open streams pruned to a 180-day window.
   * ```typescript
   * .snap((s) => s.patches >= 100)
   * .autocloses({ is: "TicketResolved", after: { days: 90 }, keep: { days: 180 } })
   * ```
   */
  autocloses: (
    policy: [TSnap] extends [true]
      ? AutoclosePolicy
      : Omit<AutoclosePolicy, "keep"> & {
          /** Rolling-window retention requires `.snap(...)` earlier in
           *  the builder chain — a windowed close prunes behind a real
           *  snapshot, so a state that never snapshots has nothing to
           *  prune behind. */
          keep?: never;
        }
  ) => ActionBuilder<TState, TEvents, TActions, TName, TSnap>;
  /**
   * Declares the archiver the online close cycle runs **before**
   * truncating a stream this state's `.autocloses(...)` predicate
   * accepted. Hosts use it to write events to durable storage (S3,
   * an analytics warehouse, cold tier) before the tombstone lands,
   * so the truncate doesn't lose history that the operator still
   * needs.
   *
   * Threads into `CloseTarget.archive` via the same plumbing
   * `app.close({ stream, archive })` already uses — the cycle holds
   * the stream's guard while the archiver runs, and a thrown
   * archiver leaves the stream guarded but un-truncated. No partial
   * truncate state, no data loss; the cycle retries the candidate
   * on the next tick.
   *
   * One archiver per state. A second `.archives(...)` call replaces
   * the first (same shape as `.snap` / `.discloses` /
   * `.autocloses`). Absent → the cycle truncates without an archive
   * step.
   *
   * @param archive `(stream, head) => Promise<void>`. Runs while
   *   the stream is locked against new writes; the truncate runs
   *   immediately after a successful resolve.
   * @returns The ActionBuilder for chaining.
   *
   * @example Archive to S3 before truncate.
   * ```typescript
   * state({ Ticket: ticketSchema })
   *   .emits({ TicketOpened, TicketResolved })
   *   // ...
   *   .autocloses({ is: "TicketResolved" })
   *   .archives(async (stream) => {
   *     const events = await loadEvents(stream);
   *     await s3.upload(`tickets/${stream}.jsonl`, events);
   *   })
   * ```
   */
  archives: (
    archive: AutocloseArchiver<TEvents>
  ) => ActionBuilder<TState, TEvents, TActions, TName, TSnap>;
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
   *   .build(); // Returns State<TState, TEvents, TActions, TName>
   * ```
   */
  build: () => State<TState, TEvents, TActions, TName>;
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
 * @template TState - Zod schema type defining the shape of the state
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
 *       { description: "Account must be open", valid: (state) => state.status === "open" }
 *     ])
 *     .emit("Deposited")  // passthrough — action payload { amount } becomes event data
 *   .on({ withdraw: z.object({ amount: z.number() }) })
 *     .given([
 *       { description: "Account must be open", valid: (state) => state.status === "open" },
 *       { description: "Funds must be available", valid: (state) => state.balance > 0 }
 *     ])
 *     .emit("Withdrawn")
 *   .on({ close: z.object({}) })
 *     .given([
 *       { description: "Account must be open", valid: (state) => state.status === "open" },
 *       { description: "Balance must be zero", valid: (state) => state.balance === 0 }
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
export function state<TName extends string, TState extends Schema>(
  entry: StateEntry<TName, TState>
): StateBuilder<TState, TName> {
  const keys = Object.keys(entry);
  if (keys.length !== 1) throw new Error("state() requires exactly one key");
  const name = keys[0] as TName;
  const state_schema = (entry as Record<string, ZodType<TState>>)[name];
  return {
    init(init) {
      return {
        emits<TEvents extends Schema>(events: ZodTypes<TEvents>) {
          // Default passthrough patches: event data merges into state
          const default_patch = Object.fromEntries(
            Object.keys(events).map((k) => {
              const fn = Object.assign(({ data }: { data: any }) => data, {
                _passthrough: true as const,
              }) satisfies PassthroughPatchHandler;
              return [k, fn];
            })
          ) as unknown as PatchHandlers<TState, TEvents>;

          // Build one mutable state object the action_builder threads
          // through every fluent call. patch() (if invoked) just mutates
          // the patch map in place — no re-builder wasted.
          const internal: State<TState, TEvents, Schemas, TName> = {
            events,
            actions: {},
            state: state_schema,
            name,
            init,
            patch: default_patch,
            on: {},
            // Step delegates initialized as identity, `pii_aware` false.
            // `act().build()` flips both on states with `sensitive(...)`
            // events to bake in the gate / split and gate the cache write.
            pii_aware: false,
            view: (event) => event,
            message: (validated) => validated,
          };

          // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} avoids string index signature
          const builder = action_builder<TState, TEvents, {}, TName>(internal);

          return Object.assign(builder, {
            patch(customPatch: Partial<PatchHandlers<TState, TEvents>>) {
              Object.assign(internal.patch, customPatch);
              return builder;
            },
          });
        },
      };
    },
  };
}

/**
 * Internal action-builder. The runtime object is a single mutable bag —
 * each fluent call (`on`, `snap`) mutates it and returns the same builder
 * cast to the widened generic type. Type-level fanout is preserved; the
 * O(N) `{...state}` spreads per call are not.
 *
 * Generics are erased to `Schemas` at runtime — the cast on return narrows
 * back to the call-site's widened types.
 */
function action_builder<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string = string,
>(
  state: State<TState, TEvents, TActions, TName>
): ActionBuilder<TState, TEvents, TActions, TName> {
  // The mutable bag — typed loosely since callers narrow on return.
  const internal = state as unknown as State<TState, TEvents, Schemas, TName>;

  const builder: ActionBuilder<TState, TEvents, TActions, TName> = {
    on<TKey extends string, TNewActions extends Schema>(
      entry: ActionEntry<TKey, TNewActions>,
      options?: ActionOptions
    ) {
      const keys = Object.keys(entry);
      if (keys.length !== 1) throw new Error(".on() requires exactly one key");
      const action = keys[0] as TKey;
      const schema = entry[action];

      if (action in internal.actions)
        throw new Error(`Duplicate action "${action}"`);

      type MergedActions = TActions & { [P in TKey]: TNewActions };
      (internal.actions as Record<string, ZodType<Schema>>)[action] = schema;
      if (options) {
        // #1269: validate the whole action bag at declaration so a bad
        // `maxRetries`/`backoff` throws ZodError at build, not a NaN gate.
        resolveActionConfig(options);
        internal.options ??= {};
        (internal.options as Record<string, ActionOptions>)[action] = options;
      }

      function given(rules: Invariant<TState>[]) {
        internal.given ??= {} as GivenHandlers<TState, Schemas>;
        (internal.given as Record<string, Invariant<TState>[]>)[action] = rules;
        return { emit };
      }

      function emit(
        handler:
          | ActionHandler<TState, TEvents, MergedActions, TKey>
          | (keyof TEvents & string)
      ) {
        if (typeof handler === "string") {
          const event_name = handler;
          // Tag the synthetic function with the static event name so
          // the act-builder can detect emissions of deprecated events
          // at build time (ACT-403). Dynamic forms — where the
          // returned event name is computed inside the user's
          // function — can't be inspected statically; they're caught
          // by the runtime warning in event-sourcing.ts.
          const emit_fn = Object.assign(
            (payload: any) => [event_name, payload],
            {
              _static_emit: event_name,
            }
          );
          (internal.on as Record<string, unknown>)[action] = emit_fn;
        } else {
          (internal.on as Record<string, unknown>)[action] = handler;
        }
        return builder as unknown as ActionBuilder<
          TState,
          TEvents,
          MergedActions,
          TName
        >;
      }

      return { given, emit };
    },

    snap(snap: (snapshot: Snapshot<TState, TEvents>) => boolean) {
      internal.snap = snap;
      // Flip the type-level TSnap flag — same runtime object, the cast
      // unlocks `.autocloses({ keep })` for the rest of the chain.
      return builder as unknown as ActionBuilder<
        TState,
        TEvents,
        TActions,
        TName,
        true
      >;
    },

    discloses(
      disclose: (
        event: Committed<TEvents, keyof TEvents & string>,
        actor: Actor
      ) => boolean
    ) {
      // Replace on every call — matches snap's state-level semantics. Operators
      // who need per-event differences branch inside the predicate.
      internal.disclose = disclose;
      return builder;
    },

    autocloses(policy: AutoclosePolicy) {
      // Declarative policy only (#1090). The online path is a synthesized
      // reaction that defers to a derivable due-time and closes — an opaque
      // function predicate has no terminal event to react to nor a window to
      // derive, so it's no longer accepted online. Operators who need custom
      // logic call `app.close(...)` from their own reaction.
      if (typeof policy === "function") {
        throw new Error(
          ".autocloses(fn) is no longer supported — pass a declarative policy " +
            "({ after, is, reaches, or }) or call app.close(...) from your own " +
            "reaction for custom logic."
        );
      }
      if (policy === null || typeof policy !== "object") {
        throw new Error(
          ".autocloses(...) requires a policy object; got " + typeof policy
        );
      }
      // The type gate (`TSnap`) already rejects `keep` before `.snap` at
      // compile time; this is the equivalent guard for untyped callers.
      if ((policy as AutoclosePolicy).keep && !internal.snap) {
        throw new Error(
          ".autocloses({ keep }) requires .snap(...) earlier in the chain — a rolling window prunes behind a real snapshot, so a state that never snapshots has nothing to prune behind."
        );
      }
      // Replace on every call — matches snap / discloses state-level
      // semantics. Compile to the predicate the reaction evaluates, and
      // cache the policy's min `after` window so the reaction knows whether
      // to park on a due-time or wait for the next event; `keep` resolves
      // to the rolling-window width the reaction prunes against.
      internal.autoclose = compile_autoclose_policy(
        policy
      ) as AutoclosePredicate<TEvents>;
      internal.autoclose_after_days = policy_min_after_days(policy);
      internal.autoclose_keep_days = policy_keep_days(policy);
      return builder;
    },

    archives(archive: AutocloseArchiver<TEvents>) {
      if (typeof archive !== "function") {
        throw new Error(
          ".archives(archive) requires a function; got " + typeof archive
        );
      }
      internal.archive = archive;
      return builder;
    },

    build(): State<TState, TEvents, TActions, TName> {
      return internal as unknown as State<TState, TEvents, TActions, TName>;
    },
  };
  return builder;
}
