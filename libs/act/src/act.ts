import EventEmitter from "events";
import {
  buildDrain,
  buildEs,
  buildHandle,
  buildHandleBatch,
  computeLagLeadRatio,
  CorrelateCycle,
  type DrainOps,
  type EsOps,
  type Handle,
  type HandleBatch,
  runCloseCycle,
  runDrainCycle,
  SettleLoop,
  type StaticTarget,
} from "./internal/index.js";
import { dispose, log, store } from "./ports.js";
import type {
  Actor,
  AsOf,
  BatchHandler,
  BlockedLease,
  CloseResult,
  CloseTarget,
  Committed,
  Drain,
  DrainOptions,
  IAct,
  Lease,
  Logger,
  Query,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  SettleOptions,
  Snapshot,
  State,
  Target,
} from "./types/index.js";

/**
 * @category Orchestrator
 * @see Store
 *
 * Main orchestrator for event-sourced state machines and workflows.
 *
 * It manages the lifecycle of actions, reactions, and event streams, providing APIs for loading state, executing actions, querying events, and draining reactions.
 *
 * ## Usage
 *
 * ```typescript
 * const app = new Act(registry, 100);
 * await app.do("increment", { stream: "counter1", actor }, { by: 1 });
 * const snapshot = await app.load(Counter, "counter1");
 * await app.drain();
 * ```
 *
 * - Register event listeners with `.on("committed", ...)` and `.on("acked", ...)` to react to lifecycle events.
 * - Use `.query()` to analyze event streams for analytics or debugging.
 *
 * @template TSchemaReg SchemaRegister for state
 * @template TEvents Schemas for events
 * @template TActions Schemas for actions
 * @template TStateMap Map of state names to state schemas
 * @template TActor Actor type extending base Actor
 */
/**
 * Default LRU cap for the subscribed-streams cache. Apps that mint many
 * dynamic targets (one per aggregate) should override via
 * {@link ActOptions.maxSubscribedStreams} based on expected concurrency.
 */
export const DEFAULT_MAX_SUBSCRIBED_STREAMS = 1000;

/**
 * Lifecycle events emitted by {@link Act}, mapped to their payload type.
 * Drives the typing of `emit` / `on` / `off` — the event-name argument
 * narrows its payload at the call site.
 */
export type ActLifecycleEvents<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
> = {
  committed: Snapshot<TSchemaReg, TEvents>[];
  acked: Lease[];
  blocked: BlockedLease[];
  settled: Drain<TEvents>;
  closed: CloseResult;
};

/**
 * Options for {@link Act} construction (passed via {@link ActBuilder.build}).
 *
 * @property maxSubscribedStreams - Cap for the LRU set tracking already-
 *   subscribed reaction streams. Default: {@link DEFAULT_MAX_SUBSCRIBED_STREAMS}.
 */
export type ActOptions = {
  readonly maxSubscribedStreams?: number;
};

export class Act<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  TStateMap extends Record<string, Schema> = Record<string, never>,
  TActor extends Actor = Actor,
> implements IAct<TEvents, TActions, TActor> {
  private _emitter = new EventEmitter();
  private _drain_locked = false;
  private _drain_lag2lead_ratio = 0.5;
  /** Event names with at least one registered reaction (computed at build time) */
  private readonly _reactive_events = new Set<string>();
  /** Set in do() when a committed event has reactions — cleared by drain() */
  private _needs_drain = false;
  /** Correlation state machine: lazy init, dynamic-resolver scan, periodic worker. */
  private readonly _correlate: CorrelateCycle<TSchemaReg, TEvents, TActions>;
  /** Debounced correlate→drain catch-up loop. */
  private readonly _settle: SettleLoop<TEvents>;

  /**
   * Emit a lifecycle event. The payload type is inferred from the event name
   * via {@link ActLifecycleEvents}.
   */
  emit<E extends keyof ActLifecycleEvents<TSchemaReg, TEvents, TActions>>(
    event: E,
    args: ActLifecycleEvents<TSchemaReg, TEvents, TActions>[E]
  ): boolean {
    return this._emitter.emit(event, args);
  }

  /**
   * Register a listener for a lifecycle event. The listener receives the
   * event-specific payload.
   */
  on<E extends keyof ActLifecycleEvents<TSchemaReg, TEvents, TActions>>(
    event: E,
    listener: (
      args: ActLifecycleEvents<TSchemaReg, TEvents, TActions>[E]
    ) => void
  ): this {
    this._emitter.on(event, listener);
    return this;
  }

  /**
   * Remove a previously registered lifecycle listener.
   */
  off<E extends keyof ActLifecycleEvents<TSchemaReg, TEvents, TActions>>(
    event: E,
    listener: (
      args: ActLifecycleEvents<TSchemaReg, TEvents, TActions>[E]
    ) => void
  ): this {
    this._emitter.off(event, listener);
    return this;
  }

  /**
   * Create a new Act orchestrator.
   *
   * @param registry The registry of state, event, and action schemas
   * @param states Map of state names to their (potentially merged) state definitions
   */
  /** Batch handlers for static-target projections (target → handler) */
  private readonly _batch_handlers: Map<string, BatchHandler<TEvents>>;
  /** Event-sourcing handlers, optionally wrapped with trace decorators */
  private readonly _es: EsOps;
  /** Correlate/drain pipeline ops, optionally wrapped with trace decorators */
  private readonly _cd: DrainOps<TEvents>;
  /**
   * Event-name → owning state, computed at build time. The duplicate-event
   * guard in merge.ts ensures one event name maps to at most one state, so
   * this lookup is unambiguous. Used by `close()` to pick the right reducer
   * set when seeding a `restart` snapshot in multi-state apps.
   */
  private readonly _event_to_state = new Map<string, State<any, any, any>>();
  /** Logger resolved at construction time (after user port configuration) */
  private readonly _logger: Logger = log();
  /** Pre-bound IAct methods reused across drain cycles. Only `do` varies per
   * payload (it captures the triggering event for reactingTo auto-inject). */
  private readonly _bound_do = this.do.bind(this);
  private readonly _bound_load = this.load.bind(this);
  private readonly _bound_query = this.query.bind(this);
  private readonly _bound_query_array = this.query_array.bind(this);
  /** Reaction dispatchers built once and handed to runDrainCycle each cycle. */
  private readonly _handle: Handle<TEvents>;
  private readonly _handle_batch: HandleBatch<TEvents>;

  constructor(
    public readonly registry: Registry<TSchemaReg, TEvents, TActions>,
    private readonly _states: Map<string, State<any, any, any>> = new Map(),
    batchHandlers: Map<string, BatchHandler<any>> = new Map(),
    options: ActOptions = {}
  ) {
    this._batch_handlers = batchHandlers;
    this._es = buildEs(this._logger);
    this._cd = buildDrain<TEvents>(this._logger);
    this._handle = buildHandle<TEvents, TActions, TActor>({
      logger: this._logger,
      boundDo: this._bound_do,
      boundLoad: this._bound_load,
      boundQuery: this._bound_query,
      boundQueryArray: this._bound_query_array,
    });
    this._handle_batch = buildHandleBatch<TEvents>(this._logger);
    // Classify resolvers and reactive events at build time. Static targets
    // are deduplicated by (target, source) — two reactions to different
    // events that route to the same projection produce one subscription.
    const statics = new Map<string, StaticTarget>();
    let hasDynamicResolvers = false;
    for (const [name, register] of Object.entries(this.registry.events)) {
      if (register.reactions.size > 0) {
        this._reactive_events.add(name);
      }
      for (const reaction of register.reactions.values()) {
        if (typeof reaction.resolver === "function") {
          hasDynamicResolvers = true;
        } else {
          const { target, source } = reaction.resolver;
          const key = `${target}|${source ?? ""}`;
          if (!statics.has(key)) statics.set(key, { stream: target, source });
        }
      }
    }
    this._correlate = new CorrelateCycle(
      this.registry,
      [...statics.values()],
      hasDynamicResolvers,
      this._cd,
      options.maxSubscribedStreams ?? DEFAULT_MAX_SUBSCRIBED_STREAMS,
      // Cold start: assume drain is needed (historical events may need processing)
      () => {
        if (this._reactive_events.size > 0) this._needs_drain = true;
      }
    );
    this._settle = new SettleLoop<TEvents>({
      logger: this._logger,
      init: () => this._correlate.init(),
      checkpoint: () => this._correlate.checkpoint,
      correlate: (q) => this.correlate(q),
      drain: (o) => this.drain(o),
      onSettled: (drain) => this.emit("settled", drain),
    });

    // Build the event-name → owning state index. Duplicate event names are
    // already rejected at registration time (merge.ts), so each entry is
    // unambiguous.
    for (const merged of this._states.values()) {
      for (const eventName of Object.keys(merged.events)) {
        this._event_to_state.set(eventName, merged);
      }
    }

    dispose(() => {
      this._emitter.removeAllListeners();
      this.stop_correlations();
      this.stop_settling();
      return Promise.resolve();
    });
  }

  /**
   * Executes an action on a state instance, committing resulting events.
   *
   * This is the primary method for modifying state. It:
   * 1. Validates the action payload against the schema
   * 2. Loads the current state snapshot
   * 3. Checks invariants (business rules)
   * 4. Executes the action handler to generate events
   * 5. Applies events to create new state
   * 6. Commits events to the store with optimistic concurrency control
   *
   * @template TKey - Action name from registered actions
   * @param action - The name of the action to execute
   * @param target - Target specification with stream ID and actor context
   * @param payload - Action payload matching the action's schema
   * @param reactingTo - Optional event that triggered this action (for correlation)
   * @param skipValidation - Skip schema validation (use carefully, for performance)
   * @returns Array of snapshots for all affected states (usually one)
   *
   * @throws {ValidationError} If payload doesn't match action schema
   * @throws {InvariantError} If business rules are violated
   * @throws {ConcurrencyError} If another process modified the stream
   *
   * @example Basic action execution
   * ```typescript
   * const snapshots = await app.do(
   *   "increment",
   *   {
   *     stream: "counter-1",
   *     actor: { id: "user1", name: "Alice" }
   *   },
   *   { by: 5 }
   * );
   *
   * console.log(snapshots[0].state.count); // Current count after increment
   * ```
   *
   * @example With error handling
   * ```typescript
   * try {
   *   await app.do(
   *     "withdraw",
   *     { stream: "account-123", actor: { id: "user1", name: "Alice" } },
   *     { amount: 1000 }
   *   );
   * } catch (error) {
   *   if (error instanceof InvariantError) {
   *     console.error("Business rule violated:", error.description);
   *   } else if (error instanceof ConcurrencyError) {
   *     console.error("Concurrent modification detected, retry...");
   *   } else if (error instanceof ValidationError) {
   *     console.error("Invalid payload:", error.details);
   *   }
   * }
   * ```
   *
   * @example Reaction triggering another action (reactingTo auto-injected)
   * ```typescript
   * const app = act()
   *   .withState(Order)
   *   .withState(Inventory)
   *   .on("OrderPlaced")
   *     .do(async function reduceInventory(event, _stream, app) {
   *       // Inside reaction handlers, reactingTo is auto-injected when omitted.
   *       // The triggering event is used by default, maintaining the correlation chain.
   *       await app.do(
   *         "reduceStock",
   *         { stream: "inventory-1", actor: { id: "sys", name: "system" } },
   *         { amount: event.data.items.length }
   *       );
   *       // To use a different correlation, pass reactingTo explicitly:
   *       // await app.do("reduceStock", target, payload, customEvent);
   *     })
   *     .to("inventory-1")
   *   .build();
   * ```
   *
   * @see {@link Target} for target structure
   * @see {@link Snapshot} for return value structure
   * @see {@link ValidationError}, {@link InvariantError}, {@link ConcurrencyError}
   */
  async do<TKey extends keyof TActions>(
    action: TKey,
    target: Target<TActor>,
    payload: Readonly<TActions[TKey]>,
    reactingTo?: Committed<TEvents, string & keyof TEvents>,
    skipValidation = false
  ) {
    const snapshots = await this._es.action(
      this.registry.actions[action],
      action,
      target,
      payload,
      reactingTo,
      skipValidation
    );
    // Flag drain needed when any committed event has reactions
    for (const snap of snapshots) {
      if (
        snap.event?.name &&
        this._reactive_events.has(snap.event.name as string)
      ) {
        this._needs_drain = true;
        break;
      }
    }
    this.emit("committed", snapshots as Snapshot<TSchemaReg, TEvents>[]);
    return snapshots;
  }

  /**
   * Loads the current state snapshot for a specific stream.
   *
   * Reconstructs the current state by replaying events from the event store.
   * Uses snapshots when available to optimize loading performance.
   *
   * Accepts either a State definition object or a state name string. When
   * using a string, the merged state (from partial states registered via
   * `.withState()`) is resolved by name.
   *
   * @template TNewState - State schema type
   * @template TNewEvents - Event schemas type
   * @template TNewActions - Action schemas type
   * @param state - The state definition or state name to load
   * @param stream - The stream ID (state instance identifier)
   * @param callback - Optional callback invoked with the loaded snapshot
   * @returns The current state snapshot for the stream
   *
   * @example Load by state definition
   * ```typescript
   * const snapshot = await app.load(Counter, "counter-1");
   * console.log(snapshot.state.count);    // Current count
   * console.log(snapshot.patches);        // Events since last snapshot
   * ```
   *
   * @example Load by state name (useful with partial states)
   * ```typescript
   * const snapshot = await app.load("Ticket", "ticket-123");
   * console.log(snapshot.state.title);    // Merged state from all partials
   * ```
   *
   * @example Load multiple states
   * ```typescript
   * const [user, account] = await Promise.all([
   *   app.load(User, "user-123"),
   *   app.load(BankAccount, "account-456")
   * ]);
   * ```
   *
   * @see {@link Snapshot} for snapshot structure
   */
  async load<
    TNewState extends Schema,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
  >(
    state: State<TNewState, TNewEvents, TNewActions>,
    stream: string,
    callback?: (snapshot: Snapshot<TNewState, TNewEvents>) => void,
    asOf?: AsOf
  ): Promise<Snapshot<TNewState, TNewEvents>>;
  async load<TKey extends keyof TStateMap & string>(
    name: TKey,
    stream: string,
    callback?: (snapshot: Snapshot<TStateMap[TKey], TEvents>) => void,
    asOf?: AsOf
  ): Promise<Snapshot<TStateMap[TKey], TEvents>>;
  async load<TNewState extends Schema>(
    stateOrName: State<TNewState, any, any> | string,
    stream: string,
    callback?: (snapshot: Snapshot<any, any>) => void,
    asOf?: AsOf
  ): Promise<Snapshot<any, any>> {
    let merged: State<any, any, any>;
    if (typeof stateOrName === "string") {
      const found = this._states.get(stateOrName);
      if (!found) throw new Error(`State "${stateOrName}" not found`);
      merged = found;
    } else {
      merged = this._states.get(stateOrName.name) || stateOrName;
    }
    return await this._es.load(merged, stream, callback, asOf);
  }

  /**
   * Queries the event store for events matching a filter.
   *
   * Use this for analyzing event streams, generating reports, or debugging.
   * The callback is invoked for each matching event, and the method returns
   * summary information (first event, last event, total count).
   *
   * For small result sets, consider using {@link query_array} instead.
   *
   * @param query - The query filter
   * @param query.stream - Filter by stream ID
   * @param query.name - Filter by event name
   * @param query.after - Filter events after this event ID
   * @param query.before - Filter events before this event ID
   * @param query.created_after - Filter events after this timestamp
   * @param query.created_before - Filter events before this timestamp
   * @param query.limit - Maximum number of events to return
   * @param callback - Optional callback invoked for each matching event
   * @returns Object with first event, last event, and total count
   *
   * @example Query all events for a stream
   * ```typescript
   * const { first, last, count } = await app.query(
   *   { stream: "counter-1" },
   *   (event) => console.log(event.name, event.data)
   * );
   * console.log(`Found ${count} events from ${first?.id} to ${last?.id}`);
   * ```
   *
   * @example Query specific event types
   * ```typescript
   * const { count } = await app.query(
   *   { name: "UserCreated", limit: 100 },
   *   (event) => {
   *     console.log("User created:", event.data.email);
   *   }
   * );
   * ```
   *
   * @example Query events in time range
   * ```typescript
   * const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
   * const { count } = await app.query({
   *   created_after: yesterday,
   *   stream: "user-123"
   * });
   * console.log(`User had ${count} events in last 24 hours`);
   * ```
   *
   * @see {@link query_array} for loading events into memory
   */
  async query(
    query: Query,
    callback?: (event: Committed<TEvents, keyof TEvents>) => void
  ): Promise<{
    first?: Committed<TEvents, keyof TEvents>;
    last?: Committed<TEvents, keyof TEvents>;
    count: number;
  }> {
    let first: Committed<TEvents, keyof TEvents> | undefined = undefined,
      last: Committed<TEvents, keyof TEvents> | undefined = undefined;
    const count = await store().query<TEvents>((e) => {
      !first && (first = e);
      last = e;
      callback && callback(e);
    }, query);
    return { first, last, count };
  }

  /**
   * Queries the event store and returns all matching events in memory.
   *
   * **Use with caution** - this loads all results into memory. For large result sets,
   * use {@link query} with a callback instead to process events incrementally.
   *
   * @param query - The query filter (same as {@link query})
   * @returns Array of all matching events
   *
   * @example Load all events for a stream
   * ```typescript
   * const events = await app.query_array({ stream: "counter-1" });
   * console.log(`Loaded ${events.length} events`);
   * events.forEach(event => console.log(event.name, event.data));
   * ```
   *
   * @example Get recent events
   * ```typescript
   * const recent = await app.query_array({
   *   stream: "user-123",
   *   limit: 10
   * });
   * ```
   *
   * @see {@link query} for large result sets
   */
  async query_array(
    query: Query
  ): Promise<Committed<TEvents, keyof TEvents>[]> {
    const events: Committed<TEvents, keyof TEvents>[] = [];
    await store().query<TEvents>((e) => events.push(e), query);
    return events;
  }

  /**
   * Processes pending reactions by draining uncommitted events from the event store.
   *
   * Runs a single drain cycle:
   * 1. Polls the store for streams with uncommitted events
   * 2. Leases streams to prevent concurrent processing
   * 3. Fetches events for each leased stream
   * 4. Executes matching reaction handlers
   * 5. Acknowledges successful reactions or blocks failing ones
   *
   * Drain uses a dual-frontier strategy to balance processing of new streams (lagging)
   * vs active streams (leading). The ratio adapts based on event pressure.
   *
   * Call `correlate()` before `drain()` to discover target streams. For a higher-level
   * API that handles debouncing, correlation, and signaling automatically, use {@link settle}.
   *
   * @param options - Drain configuration options
   * @param options.streamLimit - Maximum number of streams to process per cycle (default: 10)
   * @param options.eventLimit - Maximum events to fetch per stream (default: 10)
   * @param options.leaseMillis - Lease duration in milliseconds (default: 10000)
   * @returns Drain statistics with fetched, leased, acked, and blocked counts
   *
   * @example In tests and scripts
   * ```typescript
   * await app.do("createUser", target, payload);
   * await app.correlate();
   * await app.drain();
   * ```
   *
   * @example In production, prefer settle()
   * ```typescript
   * await app.do("CreateItem", target, input);
   * app.settle(); // debounced correlate→drain, emits "settled"
   * ```
   *
   * @see {@link settle} for debounced correlate→drain with lifecycle events
   * @see {@link correlate} for dynamic stream discovery
   * @see {@link start_correlations} for automatic correlation
   */
  async drain({
    streamLimit = 10,
    eventLimit = 10,
    leaseMillis = 10_000,
  }: DrainOptions = {}): Promise<Drain<TEvents>> {
    // Skip drain when no committed events have registered reactions
    if (!this._needs_drain) {
      return { fetched: [], leased: [], acked: [], blocked: [] };
    }

    if (this._drain_locked) {
      return { fetched: [], leased: [], acked: [], blocked: [] };
    }

    try {
      this._drain_locked = true;
      const lagging = Math.ceil(streamLimit * this._drain_lag2lead_ratio);
      const leading = streamLimit - lagging;

      const cycle = await runDrainCycle(
        this._cd,
        this.registry,
        this._batch_handlers,
        this._handle,
        this._handle_batch,
        lagging,
        leading,
        eventLimit,
        leaseMillis
      );

      if (!cycle) {
        // claim() returned no leases — fully caught up
        this._needs_drain = false;
        return { fetched: [], leased: [], acked: [], blocked: [] };
      }

      const { leased, fetched, handled, acked, blocked } = cycle;

      // Adapt next cycle's frontier split to where the pressure is.
      this._drain_lag2lead_ratio = computeLagLeadRatio(
        handled,
        lagging,
        leading
      );

      if (acked.length) this.emit("acked", acked);
      if (blocked.length) this.emit("blocked", blocked);

      // Clear the drain flag when fully caught up (nothing processed, no
      // pending errors). Errors keep the flag set so retries flow through
      // the next drain.
      const hasErrors = handled.some(({ error }) => error);
      if (!acked.length && !blocked.length && !hasErrors)
        this._needs_drain = false;

      return { fetched, leased, acked, blocked };
    } catch (error) {
      this._logger.error(error);
      return { fetched: [], leased: [], acked: [], blocked: [] };
    } finally {
      this._drain_locked = false;
    }
  }

  /**
   * Discovers and registers new streams dynamically based on reaction resolvers.
   *
   * Correlation enables "dynamic reactions" where target streams are determined at runtime
   * based on event content. For example, you might create a stats stream for each user
   * when they perform certain actions.
   *
   * This method scans events matching the query and identifies new target streams based
   * on reaction resolvers. It then registers these streams so they'll be picked up by
   * the next drain cycle.
   *
   * @param query - Query filter to scan for new correlations
   * @param query.after - Start scanning after this event ID (default: -1)
   * @param query.limit - Maximum events to scan (default: 10)
   * @returns Object with newly leased streams and last scanned event ID
   *
   * @example Manual correlation
   * ```typescript
   * // Scan for new streams
   * const { leased, last_id } = await app.correlate({ after: 0, limit: 100 });
   * console.log(`Found ${leased.length} new streams`);
   *
   * // Save last_id for next scan
   * await saveCheckpoint(last_id);
   * ```
   *
   * @example Dynamic stream creation
   * ```typescript
   * const app = act()
   *   .withState(User)
   *   .withState(UserStats)
   *   .on("UserLoggedIn")
   *     .do(async (event) => ["incrementLoginCount", {}])
   *     .to((event) => ({
   *       target: `stats-${event.stream}` // Dynamic target per user
   *     }))
   *   .build();
   *
   * // Discover stats streams as users log in
   * await app.correlate();
   * ```
   *
   * @see {@link start_correlations} for automatic periodic correlation
   * @see {@link stop_correlations} to stop automatic correlation
   */
  async correlate(
    query: Query = { after: -1, limit: 10 }
  ): Promise<{ subscribed: number; last_id: number }> {
    return this._correlate.correlate(query);
  }

  /**
   * Starts automatic periodic correlation worker for discovering new streams.
   *
   * The correlation worker runs in the background, scanning for new events and identifying
   * new target streams based on reaction resolvers. It maintains a sliding window that
   * advances with each scan, ensuring all events are eventually correlated.
   *
   * This is useful for dynamic stream creation patterns where you don't know all streams
   * upfront - they're discovered as events arrive.
   *
   * **Note:** Only one correlation worker can run at a time per Act instance.
   *
   * @param query - Query filter for correlation scans
   * @param query.after - Initial starting point (default: -1, start from beginning)
   * @param query.limit - Events to scan per cycle (default: 100)
   * @param frequency - Correlation frequency in milliseconds (default: 10000)
   * @param callback - Optional callback invoked with newly discovered streams
   * @returns `true` if worker started, `false` if already running
   *
   * @example Start automatic correlation
   * ```typescript
   * // Start correlation worker scanning every 5 seconds
   * app.start_correlations(
   *   { after: 0, limit: 100 },
   *   5000,
   *   (leased) => {
   *     console.log(`Discovered ${leased.length} new streams`);
   *   }
   * );
   *
   * // Later, stop it
   * app.stop_correlations();
   * ```
   *
   * @example With checkpoint persistence
   * ```typescript
   * // Load last checkpoint
   * const lastId = await loadCheckpoint();
   *
   * app.start_correlations(
   *   { after: lastId, limit: 100 },
   *   10000,
   *   async (leased) => {
   *     // Save checkpoint for next restart
   *     if (leased.length) {
   *       const maxId = Math.max(...leased.map(l => l.at));
   *       await saveCheckpoint(maxId);
   *     }
   *   }
   * );
   * ```
   *
   * @see {@link correlate} for manual one-time correlation
   * @see {@link stop_correlations} to stop the worker
   */
  start_correlations(
    query: Query = {},
    frequency = 10_000,
    callback?: (subscribed: number) => void
  ): boolean {
    return this._correlate.startPolling(query, frequency, callback);
  }

  /**
   * Stops the automatic correlation worker.
   *
   * Call this to stop the background correlation worker started by {@link start_correlations}.
   * This is automatically called when the Act instance is disposed.
   *
   * @example
   * ```typescript
   * // Start correlation
   * app.start_correlations();
   *
   * // Later, stop it
   * app.stop_correlations();
   * ```
   *
   * @see {@link start_correlations}
   */
  stop_correlations() {
    this._correlate.stopPolling();
  }

  /**
   * Cancels any pending or active settle cycle.
   *
   * @see {@link settle}
   */
  stop_settling() {
    this._settle.stop();
  }

  /**
   * Reset reaction stream watermarks and request a drain on the next
   * `drain()` / `settle()` cycle.
   *
   * Use this to replay events through projections (or other reaction targets)
   * after changing handler logic. Equivalent to calling `store().reset(streams)`
   * directly, but also raises the orchestrator's internal "needs drain" flag —
   * `store().reset(...)` alone leaves the flag untouched, so a settled app
   * would short-circuit and skip the replay.
   *
   * Pair with `app.settle()` (or a single `app.drain()` for small streams).
   * `settle()` loops correlate→drain until no progress is made, so one call
   * fully catches up paginated streams without forcing callers to roll
   * their own loop.
   *
   * @param streams - Reaction target streams (e.g., projection names) to reset
   * @returns Count of streams that were actually reset
   *
   * @example Rebuild a projection (production)
   * ```typescript
   * await app.reset(["my-projection"]);
   * app.settle({ eventLimit: 1000 });   // emits "settled" when fully replayed
   * ```
   *
   * @example Rebuild a projection (tests / scripts)
   * ```typescript
   * await app.reset(["my-projection"]);
   * await app.drain({ eventLimit: 1000 });   // small streams: one pass is enough
   * ```
   *
   * @see {@link Store.reset} for the underlying store primitive
   * @see {@link settle} for the debounced full-catch-up loop
   */
  async reset(streams: string[]): Promise<number> {
    const count = await store().reset(streams);
    if (count > 0 && this._reactive_events.size > 0) {
      this._needs_drain = true;
    }
    return count;
  }

  /**
   * Close the books — guard, archive, truncate, and optionally restart streams.
   *
   * Safely removes historical events from the operational store:
   *
   * 1. **Correlate** — discover pending reaction targets
   * 2. **Safety check** — skip streams with pending reactions (skipped when no reactive events)
   * 3. **Guard** — commit `__tombstone__` with `expectedVersion` to block concurrent writes
   * 4. **Load state** — for streams in `snapshots`, load final state while guarded (no races)
   * 5. **Archive** — user callback per stream (abort-all on failure, streams are guarded)
   * 6. **Truncate + seed** — atomic: delete all events, insert `__snapshot__` or `__tombstone__`
   * 7. **Cache** — invalidate (tombstoned) or warm (restarted)
   * 8. **Emit "closed"** — lifecycle event with results
   *
   * @param targets - Per-stream close options (stream, restart?, archive?)
   * @returns `{ truncated: TruncateResult, skipped: string[] }`
   *
   * @example Archive and close
   * ```typescript
   * await app.close([
   *   { stream: "order-123", archive: async () => { await archiveToS3("order-123"); } },
   *   { stream: "order-456" },
   * ]);
   * ```
   *
   * @example Close with restart (state loaded automatically after guard)
   * ```typescript
   * await app.close([
   *   { stream: "counter-1", restart: true },
   *   { stream: "counter-2" },  // tombstoned
   * ]);
   * ```
   */
  async close(targets: CloseTarget[]): Promise<CloseResult> {
    if (!targets.length) return { truncated: new Map(), skipped: [] };

    // Correlate first so dynamic reaction targets are discovered before
    // the safety check examines subscription positions.
    await this.correlate({ limit: 1000 });

    const result = await runCloseCycle(targets, {
      reactiveEventsSize: this._reactive_events.size,
      eventToState: this._event_to_state,
      load: this._es.load,
      tombstone: this._es.tombstone,
      logger: this._logger,
    });

    this.emit("closed", result);
    return result;
  }

  /**
   * Debounced, non-blocking correlate→drain cycle.
   *
   * Call this after `app.do()` (or `app.reset()`) to schedule a background
   * drain. Multiple rapid calls within the debounce window are coalesced
   * into a single cycle. Runs correlate→drain in a loop until a pass makes
   * no progress — no new subscriptions, no acks, no blocks — then emits
   * the `"settled"` lifecycle event. This means a single `settle()` call
   * fully catches up paginated streams (e.g. after `reset()` on a long
   * projection) without forcing callers to loop.
   *
   * @param options - Settle configuration options
   * @param options.debounceMs - Debounce window in milliseconds (default: 10)
   * @param options.correlate - Query filter for correlation scans (default: `{ after: -1, limit: 100 }`)
   * @param options.maxPasses - Cap on correlate→drain loops (default: `Infinity`).
   *   Early-exit on no-progress means the cap only matters in pathological cases.
   * @param options.streamLimit - Maximum streams per drain cycle (default: 10)
   * @param options.eventLimit - Maximum events per stream (default: 10)
   * @param options.leaseMillis - Lease duration in milliseconds (default: 10000)
   *
   * @example API mutations
   * ```typescript
   * await app.do("CreateItem", target, input);
   * app.settle(); // non-blocking, returns immediately
   *
   * app.on("settled", (drain) => {
   *   // notify SSE clients, invalidate caches, etc.
   * });
   * ```
   *
   * @see {@link drain} for single synchronous drain cycles
   * @see {@link correlate} for manual correlation
   */
  settle(options: SettleOptions = {}): void {
    this._settle.schedule(options);
  }
}
