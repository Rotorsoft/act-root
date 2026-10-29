/**
 * Public contracts of the fluent builders: what `state()`, `slice()`,
 * `projection()` and `act()` return at each step of the chain. The
 * builders in `../builders/` implement them.
 */
import type { ZodType } from "zod";
import type { Act } from "../act.js";
import type {
  ActionHandler,
  ActionOptions,
  ActOptions,
  Actor,
  AutocloseArchiver,
  AutoclosePolicy,
  BatchHandler,
  CacheEntry,
  Committed,
  DeferWhen,
  EventRegister,
  FoldOptions,
  IAct,
  Invariant,
  LaneConfig,
  PatchHandlers,
  Precondition,
  ReactionOptions,
  ReactionResolver,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
  ZodTypes,
} from "./index.js";
import type { DEFAULT_LANE } from "./reaction.js";

/**
 * The `.do(handler)` step, parameterized by the builder it returns (`TReturn`).
 * Identical for both builders modulo that return type.
 */
export type ReactionDo<
  TReturn,
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor,
  TLanes extends string,
  TKey extends keyof TEvents,
> = (
  handler: (
    event: Committed<TEvents, TKey>,
    stream: string,
    app: IAct<TEvents, TActions, TActor>
  ) => Promise<Snapshot<Schema, TEvents> | void>,
  options?: Partial<ReactionOptions>
) => TReturn & {
  to: (resolver: ReactionResolver<TEvents, TKey, TLanes> | string) => TReturn;
};

/**
 * The object `.on(event)` returns: run immediately with `.do(...)`, or hold
 * with `.defer(when).do(...)`. Parameterized by the return builder so
 * `act()` and `slice()` share one shape.
 */
export type ReactionOn<
  TReturn,
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor,
  TLanes extends string,
  TKey extends keyof TEvents,
> = {
  do: ReactionDo<TReturn, TEvents, TActions, TActor, TLanes, TKey>;
  defer: (
    schedule: DeferWhen | ((event: Committed<TEvents, TKey>) => DeferWhen)
  ) => {
    do: ReactionDo<TReturn, TEvents, TActions, TActor, TLanes, TKey>;
  };
};

/**
 * Builder members that return `Self` unchanged — shared by both builders.
 *
 * @template Self - the concrete builder type returned for chaining
 * @template TEvents - event schemas
 * @template TActions - action schemas
 * @template TActor - actor type
 * @template TLanes - declared lane-name union
 */
export interface BuilderBase<
  Self,
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor,
  TLanes extends string,
> {
  /**
   * Registers a standalone projection. Its events must be a subset of events
   * already registered via `.withState()` (or `.withSlice()` on the Act
   * builder); handlers keep their `(event, stream)` signature.
   */
  withProjection: <TNewEvents extends Schemas>(
    projection: [Exclude<keyof TNewEvents, keyof TEvents>] extends [never]
      ? Projection<TNewEvents>
      : never
  ) => Self;
  /**
   * Begins defining a reaction. Chain `.do(...)` to run immediately, or
   * `.defer(when).do(...)` to hold the reaction until a schedule is due.
   * `.to(...)` follows `.do(...)` in both cases and, for a deferred
   * reaction, routes it onto its own target so the hold doesn't stall the
   * stream's other reactions.
   */
  on: <TKey extends keyof TEvents>(
    event: TKey
  ) => ReactionOn<Self, TEvents, TActions, TActor, TLanes, TKey>;
  /** The registered event schemas and their reaction maps. */
  readonly events: EventRegister<TEvents>;
}

/**
 * Fluent builder interface for composing event-sourced applications.
 *
 * Provides a chainable API for:
 * - Registering states via `.withState()`
 * - Registering slices via `.withSlice()`
 * - Registering projections via `.withProjection()`
 * - Locking a custom actor type via `.withActor<TActor>()`
 * - Declaring drain lanes via `.withLane({name, ...})`
 * - Defining event reactions via `.on()` → `.do()` → `.to()`
 * - Building the orchestrator via `.build()`
 *
 * @template TSchemaReg - Schema register for states (maps action names to state schemas)
 * @template TEvents - Event schemas (maps event names to event data schemas)
 * @template TActions - Action schemas (maps action names to action payload schemas)
 * @template TStateMap - Map of state names to state schemas
 * @template TActor - Actor type extending base Actor
 * @template TLanes - Union of declared lane names. Narrowed by
 *   `.withLane({name})` calls so `.to({lane})` and `ActOptions.onlyLanes`
 *   reject typos at compile time. Starts at `"default"`.
 *
 * @see {@link act} for usage examples
 * @see {@link Act} for the built orchestrator API
 */
export interface ActBuilder<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> extends BuilderBase<
    ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>,
    TEvents,
    TActions,
    TActor,
    TLanes
  > {
  /**
   * Registers a state definition with the builder.
   *
   * State names, action names, and event names must be unique across the
   * application (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   */
  withState: <
    TNewState extends Schema,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
    TNewName extends string = string,
  >(
    state: State<TNewState, TNewEvents, TNewActions, TNewName>
  ) => ActBuilder<
    TSchemaReg & { [K in keyof TNewActions]: TNewState },
    TEvents & TNewEvents,
    TActions & TNewActions,
    TStateMap & { [K in TNewName]: TNewState },
    TActor,
    TLanes
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
    TNewSchemaReg extends SchemaRegister<TNewActions>,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
    TNewMap extends Record<string, Schema>,
    TNewLanes extends string,
  >(
    slice: Slice<
      TNewSchemaReg,
      TNewEvents,
      TNewActions,
      TNewMap,
      Actor,
      TNewLanes
    >
  ) => ActBuilder<
    TSchemaReg & TNewSchemaReg,
    TEvents & TNewEvents,
    TActions & TNewActions,
    TStateMap & TNewMap,
    TActor,
    TLanes | TNewLanes
  >;
  /**
   * Locks a custom actor type for this application.
   *
   * This is a pure type-level method — it returns the same builder at
   * runtime but narrows the `TActor` generic so that `app.do()` and
   * reaction dispatchers require the richer actor shape.
   *
   * @template TNewActor - Custom actor type extending base Actor
   * @returns The same builder with `TActor` locked to `TNewActor`
   *
   * @example
   * ```typescript
   * type MyActor = { id: string; name: string; role: string; tenantId: string };
   *
   * const app = act()
   *   .withActor<MyActor>()
   *   .withState(Counter)
   *   .build();
   *
   * // Now app.do() requires MyActor in the target
   * await app.do("increment", {
   *   stream: "counter-1",
   *   actor: { id: "1", name: "Alice", role: "admin", tenantId: "t1" }
   * }, { by: 5 });
   * ```
   */
  withActor: <TNewActor extends Actor>() => ActBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TNewActor,
    TLanes
  >;
  /**
   * Declares a drain lane. Lane name narrows `TLanes` so
   * `.to({lane})` and `ActOptions.onlyLanes` type-check against it.
   *
   * @example
   * ```typescript
   * const app = act()
   *   .withState(Counter)
   *   .withLane({ name: "slow", leaseMillis: 60_000, streamLimit: 5 })
   *   .on("OrderConfirmed")
   *     .do(deliverWebhook)
   *     .to({ target: "webhooks-out", lane: "slow" })
   *   .build();
   * ```
   */
  withLane: <const TConfig extends LaneConfig>(
    config: TConfig
  ) => ActBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TActor,
    TLanes | TConfig["name"]
  >;
  /**
   * Builds and returns the Act orchestrator instance.
   *
   * @param options - Optional runtime overrides (see {@link ActOptions}).
   *   `options.onlyLanes` is narrowed to the declared `TLanes` union, so
   *   `onlyLanes: ["typo"]` is a compile error when the lane wasn't
   *   declared via `.withLane(...)`.
   * @returns The Act orchestrator instance
   *
   * @see {@link Act} for available orchestrator methods
   */
  build: (
    options?: ActOptions<TLanes>
  ) => Act<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
}

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
      // `{}` avoids the string index signature `Record<string, never>` would add
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
        // `{}` avoids the string index signature `Record<string, never>` would add
      ) => ActionBuilder<TState, TEvents, {}, TName>;
    };
  };
};

/** Helper: a single-key record mapping a state name to its Zod schema. */
export type StateEntry<
  TKey extends string = string,
  TState extends Schema = Schema,
> = {
  [P in TKey]: ZodType<TState>;
};

/** Helper: a single-key record mapping an action name to its Zod schema. */
export type ActionEntry<
  TKey extends string = string,
  TNewActions extends Schema = Schema,
> = {
  [P in TKey]: ZodType<TNewActions>;
};

/**
 * The `.emit(...)` step that finishes an action declaration: a handler that
 * returns the events, or an event name to pass the payload through as the
 * event data.
 */
type ActionEmit<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string,
  TSnap extends boolean,
  TKey extends string,
  TNewActions extends Schema,
> = {
  /** Custom handler — receives `(action, snapshot)` and returns one
   *  or more `[EventName, data]` tuples (or `undefined`). */
  (
    handler: ActionHandler<TState, TEvents, { [P in TKey]: TNewActions }, TKey>
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

/**
 * What follows `.on(...)` or `.given(...)`: the preconditions, then the
 * `.emit(...)` that finishes the action.
 */
type ActionRules<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string,
  TSnap extends boolean,
  TKey extends string,
  TNewActions extends Schema,
> = {
  /**
   * Adds named preconditions the action requires: what the state, the
   * actor and the payload must meet for the action to run now.
   *
   * They're checked in declaration order, before the handler runs. Each
   * pairs a `description` with a `holds(payload, state, actor?)` predicate;
   * the first that returns `false` refuses the action with
   * `PreconditionError` carrying its description. A rule that ignores the
   * payload (typed `Precondition<S, unknown>`) fits every action, so
   * declare it once and reuse it.
   *
   * @param rules - Array of {@link Precondition} objects (`{ description, holds }`)
   * @returns An object with `.emit()` to finalize the action
   *
   * @example
   * ```typescript
   * .requires([
   *   { description: "Must be active", holds: (_, s) => s.status === "active" },
   *   { description: "Must own the territory", holds: (p, s, actor) => s.owners[p.from] === actor?.id },
   * ])
   * ```
   */
  requires: (rules: Precondition<TState, TNewActions>[]) => {
    /**
     * Defines the action handler that emits events, as `.emit()` after
     * `.on()` does: a handler returning the events to emit (none is fine),
     * or an event name to pass the payload through as the event data.
     */
    emit: ActionEmit<
      TState,
      TEvents,
      TActions,
      TName,
      TSnap,
      TKey,
      TNewActions
    >;
  };
  /**
   * Defines the action handler that emits events.
   *
   * The handler receives the action payload and current state snapshot,
   * and returns the events to emit, or nothing (`undefined` or `[]`) to
   * commit nothing. Events are applied to state via the patch handlers
   * defined earlier.
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
   */
  emit: ActionEmit<TState, TEvents, TActions, TName, TSnap, TKey, TNewActions>;
};

/**
 * Builder interface for defining actions (commands) on a state.
 *
 * Actions represent user/system intents to modify state. Each action is validated
 * against a schema, can declare preconditions, and emits zero or more events.
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
   * their schema and emit zero or more events (none commits nothing).
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
   * @returns An object with `.given()`, `.requires()` and `.emit()` for further configuration
   *
   * @example Simple action without preconditions
   * ```typescript
   * .on({ increment: z.object({ by: z.number() }) })
   *   .emit((action) => ["Incremented", { amount: action.by }])
   * ```
   */
  on: <TKey extends string, TNewActions extends Schema>(
    entry: ActionEntry<TKey, TNewActions>,
    options?: ActionOptions
  ) => ActionRules<
    TState,
    TEvents,
    TActions,
    TName,
    TSnap,
    TKey,
    TNewActions
  > & {
    /**
     * Adds rules the current state (and the actor) must meet for the action
     * to run now, checked before `.requires()`. A rule whose
     * `valid(state, actor?)` returns `false` refuses the action with the
     * deprecated `InvariantError` (`"<action> failed invariant: ..."`).
     *
     * @deprecated These rules are preconditions, not invariants. Declare
     * them with `.requires()`, whose `holds(payload, state, actor?)` can
     * ignore the payload; invariants belong in the state's schema. Removed
     * in 2.0.
     *
     * @param rules - Array of {@link Invariant} objects (`{ description, valid }`)
     * @returns An object with `.requires()` and `.emit()` to finish the action
     */
    given: (
      rules: Invariant<TState>[]
    ) => ActionRules<
      TState,
      TEvents,
      TActions,
      TName,
      TSnap,
      TKey,
      TNewActions
    >;
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
   * reactions are unaffected — they follow separate visibility rules.
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
   * Under the hood this compiles to a synthesized reaction that runs
   * on a per-aggregate synthetic stream: it defers to `head.created + the
   * policy's min after` while the cooldown holds and closes the stream once
   * the policy matches. There is no background sweep.
   *
   * There is no function-predicate form: an opaque predicate has no
   * derivable due-time or terminal event to react to. For conditions the
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
   * truncate state, no data loss. It is not retried automatically;
   * `app.close([{ stream, archive }])` resumes the guarded stream.
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
   * Call this method after defining all actions, preconditions, and patches to create
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
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> = {
  readonly _tag: "Slice";
  readonly states: Map<string, State<any, any, any>>;
  readonly events: EventRegister<TEvents>;
  readonly projections: ReadonlyArray<Projection<any>>;
  /**
   * Drain lanes declared on this slice via `.withLane(...)`.
   * `act().withSlice(slice)` merges these into the Act's lane set so
   * `.to({lane})` is statically checked at the slice's call site against
   * the lanes the slice itself declared.
   */
  readonly lanes: ReadonlyArray<LaneConfig>;
  /** @internal phantom field for type-level state schema tracking */
  readonly _S?: TSchemaReg;
  /** @internal phantom field for type-level state name tracking */
  readonly _M?: TStateMap;
  /** @internal phantom field for type-level actor tracking */
  readonly _TActor?: TActor;
  /** @internal phantom field for type-level lane union tracking */
  readonly _TLanes?: TLanes;
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
export interface SliceBuilder<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> extends BuilderBase<
    SliceBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>,
    TEvents,
    TActions,
    TActor,
    TLanes
  > {
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
    TActor,
    TLanes
  >;
  /**
   * Declares a drain lane on this slice. Merged into the
   * parent Act's lane set by `act().withSlice(slice)`.
   */
  withLane: <const TConfig extends LaneConfig>(
    config: TConfig
  ) => SliceBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TActor,
    TLanes | TConfig["name"]
  >;
  /**
   * Builds and returns the Slice data structure.
   */
  build: () => Slice<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>;
}

/**
 * A self-contained projection grouping read-model update handlers.
 * Projections are composed into an Act orchestrator via `act().withProjection(projection)`.
 *
 * @template TEvents - Event schemas handled by this projection
 */
export type Projection<TEvents extends Schemas> = {
  readonly _tag: "Projection";
  readonly events: EventRegister<TEvents>;
  readonly target?: string;
  readonly batchHandler?: BatchHandler<TEvents>;
  /**
   * State-fold spec from `.of()`. The builder only records intent — the
   * orchestrator resolves the REGISTRY-MERGED full state at
   * `act().build()` and synthesizes the batch handler there, so the
   * fold always covers every reducer of the state, including partials
   * merged by slices the projection never saw.
   * @internal
   */
  readonly fold?: {
    readonly name: string;
    readonly flush: (rows: ReadonlyArray<CacheEntry<any>>) => Promise<void>;
    readonly config: Required<FoldOptions>;
  };
};

/**
 * The `.of()` continuation: state projections flush the cache layer
 * outward — the rows ARE the streams' {@link CacheEntry} values, one
 * per dirty stream per flush round. Must be an idempotent upsert keyed
 * on `stream` (guard with `event_id` for order safety when a rebuild
 * races a live worker).
 */
export type FoldFlush<TState extends Schema, TE extends Schemas> = {
  flush: (
    handler: (rows: ReadonlyArray<CacheEntry<TState>>) => Promise<void>
  ) => {
    build: () => Projection<TE>;
  };
};

/**
 * `.of()` accepts the partials of ONE state (same name, enforced at the
 * type level via `TName`) purely for typing and event registration —
 * the fold itself always runs on the registry-merged full state,
 * resolved at `act().build()`. Passing every partial is required: the
 * orchestrator validates completeness at build and throws on missing
 * events.
 */
export type OfSignatures = {
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1, TE1>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2, TE1 & TE2>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TS3 extends Schema,
    TE3 extends Schemas,
    TA3 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    s3: State<TS3, TE3, TA3, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2 & TS3, TE1 & TE2 & TE3>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TS3 extends Schema,
    TE3 extends Schemas,
    TA3 extends Schemas,
    TS4 extends Schema,
    TE4 extends Schemas,
    TA4 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    s3: State<TS3, TE3, TA3, TN>,
    s4: State<TS4, TE4, TA4, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2 & TS3 & TS4, TE1 & TE2 & TE3 & TE4>;
};

/** Helper: a single-key record mapping an event name to its Zod schema. */
export type EventEntry<
  TKey extends string = string,
  TData extends Schema = Schema,
> = {
  [P in TKey]: ZodType<TData>;
};

/** Infer the handler-result type after registering one event. */
export type DoResult<
  TEvents extends Schemas,
  TKey extends string,
  TData extends Schema,
  TTarget extends string | undefined = undefined,
> = ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget, true> & {
  to: (
    resolver: ReactionResolver<TEvents & { [P in TKey]: TData }, TKey> | string
  ) => ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget, true>;
};

/**
 * Fluent builder interface for composing projections.
 *
 * When a static target is provided via `projection("target")`, the builder
 * exposes a `.batch()` method for registering a batch handler that processes
 * all events in a single call.
 *
 * @template TEvents - Event schemas
 * @template TTarget - Static target string or undefined
 */
export type ProjectionBuilder<
  TEvents extends Schemas,
  TTarget extends string | undefined = undefined,
  THasHandlers extends boolean = false,
> = {
  /**
   * Begins defining a projection handler for a specific event.
   *
   * Pass a `{ EventName: schema }` record — use shorthand `{ EventName }`
   * when the variable name matches the event name. The key becomes the
   * event name, the value the Zod schema.
   */
  on: <TKey extends string, TData extends Schema>(
    entry: EventEntry<TKey, TData>
  ) => {
    do: (
      handler: (
        event: Committed<TEvents & { [P in TKey]: TData }, TKey>,
        stream: string
      ) => Promise<void>
    ) => DoResult<TEvents, TKey, TData, TTarget>;
  };
  /**
   * Builds and returns the Projection data structure.
   */
  build: () => Projection<TEvents>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<TEvents>;
} & (TTarget extends string
  ? {
      /**
       * Registers a batch handler that processes all events in a single call.
       *
       * Only available on projections with a static target (`projection("target")`).
       * The handler receives a discriminated union of all declared events,
       * enabling bulk DB operations in a single transaction.
       *
       * When defined, the batch handler is always called — even for a single event.
       * Individual `.do()` handlers serve as fallback for projections without `.batch()`.
       */
      batch: (handler: BatchHandler<TEvents>) => {
        build: () => Projection<TEvents>;
      };
    } & (THasHandlers extends false
      ? {
          /**
           * Declares a state projection: fold every event of the given
           * state through its own reducers and flush one row per stream —
           * the queryable list of the aggregates themselves.
           *
           * The state is the filter: the projection consumes exactly the
           * state's event register, so in a multi-state app only that
           * state's streams are folded — and every event of a folded
           * stream reaches the reducer. Write amplification tracks the
           * distinct stream count, not the event count; `app.reset`
           * rebuilds in O(streams) upserts.
           *
           * The fluent chain enforces the shape: `.of()` is only offered
           * before any `.on()` handler, and narrows to `.flush()` +
           * `.build()` — a projection either folds a state or declares
           * handlers, never both.
           */
          of: OfSignatures;
        }
      : {})
  : {});
