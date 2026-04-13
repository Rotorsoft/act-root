import { randomUUID } from "crypto";
import EventEmitter from "events";
import { config } from "./config.js";
import * as es from "./event-sourcing.js";
import {
  build_tracer,
  cache,
  dispose,
  log,
  store,
  TOMBSTONE_EVENT,
} from "./ports.js";
import type {
  Actor,
  AsOf,
  BatchHandler,
  CloseResult,
  CloseTarget,
  Committed,
  Drain,
  DrainOptions,
  IAct,
  Lease,
  Query,
  ReactionPayload,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  SettleOptions,
  Snapshot,
  State,
  Target,
} from "./types/index.js";

const logger = log();
const tracer = build_tracer(config().logLevel);

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
  private _correlation_timer: ReturnType<typeof setInterval> | undefined =
    undefined;
  private _settle_timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private _settling = false;
  private _correlation_checkpoint = -1;
  private _subscribed_statics = new Set<string>();
  private _has_dynamic_resolvers = false;
  private _correlation_initialized = false;
  /** Event names with at least one registered reaction (computed at build time) */
  private readonly _reactive_events = new Set<string>();
  /** Set in do() when a committed event has reactions — cleared by drain() */
  private _needs_drain = false;

  /**
   * Emit a lifecycle event (internal use, but can be used for custom listeners).
   *
   * @param event The event name ("committed", "acked",  or "blocked")
   * @param args The event payload
   * @returns true if the event had listeners, false otherwise
   */
  emit(event: "committed", args: Snapshot<TSchemaReg, TEvents>[]): boolean;
  emit(event: "acked", args: Lease[]): boolean;
  emit(event: "blocked", args: Array<Lease & { error: string }>): boolean;
  emit(event: "settled", args: Drain<TEvents>): boolean;
  emit(event: "closed", args: CloseResult): boolean;
  emit(event: string, args: any): boolean {
    return this._emitter.emit(event, args);
  }

  /**
   * Register a listener for a lifecycle event ("committed", "acked", or "blocked").
   *
   * @param event The event name
   * @param listener The callback function
   * @returns this (for chaining)
   */
  on(
    event: "committed",
    listener: (args: Snapshot<TSchemaReg, TEvents>[]) => void
  ): this;
  on(event: "acked", listener: (args: Lease[]) => void): this;
  on(
    event: "blocked",
    listener: (args: Array<Lease & { error: string }>) => void
  ): this;
  on(event: "settled", listener: (args: Drain<TEvents>) => void): this;
  on(event: "closed", listener: (args: CloseResult) => void): this;
  on(event: string, listener: (args: any) => void): this {
    this._emitter.on(event, listener);
    return this;
  }

  /**
   * Remove a listener for a lifecycle event.
   *
   * @param event The event name
   * @param listener The callback function
   * @returns this (for chaining)
   */
  off(
    event: "committed",
    listener: (args: Snapshot<TSchemaReg, TEvents>[]) => void
  ): this;
  off(event: "acked", listener: (args: Lease[]) => void): this;
  off(
    event: "blocked",
    listener: (args: Array<Lease & { error: string }>) => void
  ): this;
  off(event: "settled", listener: (args: Drain<TEvents>) => void): this;
  off(event: "closed", listener: (args: CloseResult) => void): this;
  off(event: string, listener: (args: any) => void): this {
    this._emitter.off(event, listener);
    return this;
  }

  /**
   * Create a new Act orchestrator.
   *
   * @param registry The registry of state, event, and action schemas
   * @param states Map of state names to their (potentially merged) state definitions
   */
  /** Static resolver targets collected at build time */
  private readonly _static_targets: Array<{ stream: string; source?: string }>;
  /** Batch handlers for static-target projections (target → handler) */
  private readonly _batch_handlers: Map<string, BatchHandler<TEvents>>;

  constructor(
    public readonly registry: Registry<TSchemaReg, TEvents, TActions>,
    private readonly _states: Map<string, State<any, any, any>> = new Map(),
    batchHandlers: Map<string, BatchHandler<any>> = new Map()
  ) {
    this._batch_handlers = batchHandlers as Map<string, BatchHandler<TEvents>>;
    // Classify resolvers and reactive events at build time
    const statics: Array<{ stream: string; source?: string }> = [];
    for (const [name, register] of Object.entries(this.registry.events)) {
      if (register.reactions.size > 0) {
        this._reactive_events.add(name);
      }
      for (const reaction of register.reactions.values()) {
        if (typeof reaction.resolver === "function") {
          this._has_dynamic_resolvers = true;
        } else {
          statics.push({
            stream: reaction.resolver.target,
            source: reaction.resolver.source,
          });
        }
      }
    }
    this._static_targets = statics;

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
   * @example Reaction triggering another action
   * ```typescript
   * const app = act()
   *   .withState(Order)
   *   .withState(Inventory)
   *   .on("OrderPlaced")
   *     .do(async (event, context) => {
   *       // This action is triggered by an event
   *       const result = await context.app.do(
   *         "reduceStock",
   *         {
   *           stream: "inventory-1",
   *           actor: event.meta.causation.action.actor
   *         },
   *         { amount: event.data.items.length },
   *         event // Pass event for correlation tracking
   *       );
   *       return result;
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
    const snapshots = await es.action(
      this.registry.actions[action],
      action,
      target as Target,
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
    return await es.load(merged, stream, callback, asOf);
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
   * Handles leased reactions.
   *
   * This is called by the main `drain` loop after fetching new events.
   * It handles reactions, supporting retries, blocking, and error handling.
   *
   * @internal
   * @param lease The lease to handle
   * @param payloads The reactions to handle
   * @returns The lease with results
   */
  private async handle(
    lease: Lease,
    payloads: ReactionPayload<TEvents>[]
  ): Promise<{
    readonly lease: Lease;
    readonly handled: number;
    readonly at: number;
    readonly error?: string;
    readonly block?: boolean;
  }> {
    // no payloads, just advance the lease
    if (payloads.length === 0) return { lease, handled: 0, at: lease.at };

    const stream = lease.stream;
    let at = payloads.at(0)!.event.id,
      handled = 0;

    lease.retry > 0 &&
      logger.warn(`Retrying ${stream}@${at} (${lease.retry}).`);

    for (const payload of payloads) {
      const { event, handler, options } = payload;
      try {
        await handler(event, stream, this); // the actual reaction
        at = event.id;
        handled++;
      } catch (error) {
        logger.error(error);
        const block = lease.retry >= options.maxRetries && options.blockOnError;
        block &&
          logger.error(`Blocking ${stream} after ${lease.retry} retries.`);
        return {
          lease,
          handled,
          at,
          // only report error when nothing was handled
          error: handled === 0 ? (error as Error).message : undefined,
          block,
        };
      }
    }
    return { lease, handled, at };
  }

  /**
   * Handles a batch of events for a projection with a batch handler.
   *
   * Called by `drain()` when a leased stream is a static-target projection
   * with a registered batch handler. All events are passed to the handler
   * in a single call, enabling bulk DB operations.
   *
   * @internal
   * @param lease The lease to handle
   * @param payloads The reactions to handle
   * @param batchHandler The batch handler for this projection
   * @returns The lease with results
   */
  private async handleBatch(
    lease: Lease,
    payloads: ReactionPayload<TEvents>[],
    batchHandler: BatchHandler<TEvents>
  ): Promise<{
    readonly lease: Lease;
    readonly handled: number;
    readonly at: number;
    readonly error?: string;
    readonly block?: boolean;
  }> {
    const stream = lease.stream;
    const events = payloads.map((p) => p.event);
    const at = events.at(-1)!.id;

    lease.retry > 0 &&
      logger.warn(`Retrying batch ${stream}@${events[0].id} (${lease.retry}).`);

    try {
      await batchHandler(events, stream);
      return { lease, handled: events.length, at };
    } catch (error) {
      logger.error(error);
      const { options } = payloads[0];
      const block = lease.retry >= options.maxRetries && options.blockOnError;
      block && logger.error(`Blocking ${stream} after ${lease.retry} retries.`);
      return {
        lease,
        handled: 0,
        at: lease.at,
        error: (error as Error).message,
        block,
      };
    }
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

    if (!this._drain_locked) {
      try {
        this._drain_locked = true;
        const lagging = Math.ceil(streamLimit * this._drain_lag2lead_ratio);
        const leading = streamLimit - lagging;

        // Atomically discover and lease streams (competing consumer pattern)
        const leased = await store().claim(
          lagging,
          leading,
          randomUUID(),
          leaseMillis
        );
        if (!leased.length) {
          this._needs_drain = false;
          return { fetched: [], leased: [], acked: [], blocked: [] };
        }

        // Fetch events for each leased stream
        const fetched = await Promise.all(
          leased.map(async ({ stream, source, at, lagging }) => {
            const events = await this.query_array({
              stream: source,
              after: at,
              limit: eventLimit,
            });
            return { stream, source, at, lagging, events } as const;
          })
        );
        tracer.fetched(fetched);

        const payloadsMap = new Map<string, ReactionPayload<TEvents>[]>();

        // compute fetch window max event id
        const fetch_window_at = fetched.reduce(
          (max, { at, events }) => Math.max(max, events.at(-1)?.id || at),
          0
        );

        fetched.forEach(({ stream, events }) => {
          const payloads = events.flatMap((event) => {
            const register = this.registry.events[event.name];
            if (!register) return [];
            return [...register.reactions.values()]
              .filter((reaction) => {
                const resolved =
                  typeof reaction.resolver === "function"
                    ? reaction.resolver(event)
                    : reaction.resolver;
                return resolved && resolved.target === stream;
              })
              .map((reaction) => ({ ...reaction, event }));
          });
          payloadsMap.set(stream, payloads as ReactionPayload<TEvents>[]);
        });

        tracer.leased(leased);

        const handled = await Promise.all(
          leased.map((lease) => {
            // fast-forward watermark using fetched events or window max
            const streamFetch = fetched.find((f) => f.stream === lease.stream);
            const at = streamFetch?.events.at(-1)?.id || fetch_window_at;
            const payloads = payloadsMap.get(lease.stream)!;
            const batchHandler = this._batch_handlers.get(lease.stream);
            if (batchHandler && payloads.length > 0) {
              return this.handleBatch({ ...lease, at }, payloads, batchHandler);
            }
            return this.handle({ ...lease, at }, payloads);
          })
        );

        // adaptive drain ratio based on handled events, favors frontier with highest pressure (clamped between 20% and 80%)
        const [lagging_handled, leading_handled] = handled.reduce(
          ([lagging_handled, leading_handled], { lease, handled }) => [
            lagging_handled + (lease.lagging ? handled : 0),
            leading_handled + (lease.lagging ? 0 : handled),
          ],
          [0, 0]
        );
        const lagging_avg = lagging > 0 ? lagging_handled / lagging : 0;
        const leading_avg = leading > 0 ? leading_handled / leading : 0;
        const total = lagging_avg + leading_avg;
        this._drain_lag2lead_ratio =
          total > 0 ? Math.max(0.2, Math.min(0.8, lagging_avg / total)) : 0.5;

        const acked = await store().ack(
          handled
            .filter(({ error }) => !error)
            .map(({ at, lease }) => ({ ...lease, at }))
        );
        if (acked.length) {
          tracer.acked(acked);
          this.emit("acked", acked);
        }

        const blocked = await store().block(
          handled
            .filter(({ block }) => block)
            .map(({ lease, error }) => ({ ...lease, error: error! }))
        );
        if (blocked.length) {
          tracer.blocked(blocked);
          this.emit("blocked", blocked);
        }

        const result = { fetched, leased, acked, blocked };
        // Clear flag when fully caught up (nothing processed, no pending errors)
        const hasErrors = handled.some(({ error }) => error);
        if (!acked.length && !blocked.length && !hasErrors)
          this._needs_drain = false;
        return result;
      } catch (error) {
        logger.error(error);
      } finally {
        this._drain_locked = false;
      }
    }

    return { fetched: [], leased: [], acked: [], blocked: [] };
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
  /**
   * Initialize correlation state on first call.
   * - Reads max(at) from store as cold-start checkpoint
   * - Subscribes static resolver targets (idempotent upsert)
   * - Populates the subscribed statics set
   * @internal
   */
  private async _init_correlation(): Promise<void> {
    if (this._correlation_initialized) return;
    this._correlation_initialized = true;

    // Subscribe static targets + read cold-start checkpoint from watermarks
    const { watermark } = await store().subscribe(this._static_targets);
    this._correlation_checkpoint = watermark;
    // Cold start: assume drain is needed (historical events may need processing)
    if (this._reactive_events.size > 0) this._needs_drain = true;
    for (const { stream } of this._static_targets) {
      this._subscribed_statics.add(stream);
    }
  }

  async correlate(
    query: Query = { after: -1, limit: 10 }
  ): Promise<{ subscribed: number; last_id: number }> {
    await this._init_correlation();

    // No dynamic resolvers — nothing to discover
    if (!this._has_dynamic_resolvers)
      return { subscribed: 0, last_id: this._correlation_checkpoint };

    // Use checkpoint as floor, allow explicit query.after to override upward
    const after = Math.max(this._correlation_checkpoint, query.after || -1);
    const correlated = new Map<
      string,
      { source?: string; payloads: ReactionPayload<TEvents>[] }
    >();
    let last_id = after;
    await store().query<TEvents>(
      (event) => {
        last_id = event.id;
        const register = this.registry.events[event.name];
        // skip events with no registered reactions
        if (register) {
          for (const reaction of register.reactions.values()) {
            // only evaluate dynamic resolvers — statics are subscribed at init
            if (typeof reaction.resolver !== "function") continue;
            const resolved = reaction.resolver(event);
            if (resolved && !this._subscribed_statics.has(resolved.target)) {
              const entry = correlated.get(resolved.target) || {
                source: resolved.source,
                payloads: [],
              };
              entry.payloads.push({
                ...reaction,
                source: resolved.source,
                event,
              });
              correlated.set(resolved.target, entry);
            }
          }
        }
      },
      { ...query, after }
    );

    if (correlated.size) {
      const streams = [...correlated.entries()].map(([stream, { source }]) => ({
        stream,
        source,
      }));
      const { subscribed } = await store().subscribe(streams);
      // Advance checkpoint only after subscribe succeeds
      this._correlation_checkpoint = last_id;
      if (subscribed) {
        tracer.correlated(streams);
        // Track newly subscribed dynamic targets
        for (const { stream } of streams) {
          this._subscribed_statics.add(stream);
        }
      }
      return { subscribed, last_id };
    }
    // No streams to subscribe — safe to advance
    this._correlation_checkpoint = last_id;
    return { subscribed: 0, last_id };
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
    if (this._correlation_timer) return false;

    const limit = query.limit || 100;
    this._correlation_timer = setInterval(
      () =>
        this.correlate({ ...query, after: this._correlation_checkpoint, limit })
          .then((result) => {
            if (callback && result.subscribed) callback(result.subscribed);
          })
          .catch(console.error),
      frequency
    );
    return true;
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
    if (this._correlation_timer) {
      clearInterval(this._correlation_timer);
      this._correlation_timer = undefined;
    }
  }

  /**
   * Cancels any pending or active settle cycle.
   *
   * @see {@link settle}
   */
  stop_settling() {
    if (this._settle_timer) {
      clearTimeout(this._settle_timer);
      this._settle_timer = undefined;
    }
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

    const targetMap = new Map(targets.map((t) => [t.stream, t]));
    const streams = [...targetMap.keys()];

    // 1. Correlate — ensure all dynamic reaction targets are discovered
    await this.correlate({ limit: 1000 });

    // 2. Find max domain event ID + version per stream (parallel, O(1) each)
    const streamInfo = new Map<string, { maxId: number; version: number }>();
    await Promise.all(
      streams.map(async (s) => {
        let maxId = -1;
        let version = -1;
        await store().query(
          (e) => {
            if (e.name !== TOMBSTONE_EVENT) {
              maxId = e.id;
              version = e.version;
            }
          },
          { stream: s, stream_exact: true, backward: true, limit: 1 }
        );
        if (maxId >= 0) streamInfo.set(s, { maxId, version });
      })
    );

    // 3. Safety check — skip entirely when app has no reactions
    const skipped: string[] = [];
    let safe: string[];

    if (this._reactive_events.size === 0) {
      safe = [...streamInfo.keys()];
    } else {
      const pendingSet = new Set<string>();
      const leases = await store().claim(1000, 1000, randomUUID(), 1);
      if (leases.length) await store().ack(leases);

      for (const lease of leases) {
        const sourceRe = lease.source ? RegExp(lease.source) : undefined;
        for (const [stream, info] of streamInfo) {
          if ((!sourceRe || sourceRe.test(stream)) && lease.at < info.maxId) {
            pendingSet.add(stream);
          }
        }
      }

      safe = [];
      for (const [stream] of streamInfo) {
        if (pendingSet.has(stream)) {
          skipped.push(stream);
        } else {
          safe.push(stream);
        }
      }
    }

    if (!safe.length) {
      const result: CloseResult = { truncated: new Map(), skipped };
      this.emit("closed", result);
      return result;
    }

    // 4. Guard — commit tombstone with expectedVersion to block concurrent writes.
    //    All guards share a correlation UUID (the close operation ID).
    const correlation = randomUUID();
    const guarded: string[] = [];
    const guardEvents = new Map<string, { id: number; stream: string }>();
    await Promise.all(
      safe.map(async (stream) => {
        try {
          const info = streamInfo.get(stream)!;
          const [committed] = await store().commit(
            stream,
            [{ name: TOMBSTONE_EVENT, data: {} }],
            { correlation, causation: {} },
            info.version
          );
          guarded.push(stream);
          guardEvents.set(stream, { id: committed.id, stream });
        } catch {
          skipped.push(stream);
        }
      })
    );

    if (!guarded.length) {
      const result: CloseResult = { truncated: new Map(), skipped };
      this.emit("closed", result);
      return result;
    }

    // 5. Load final state for restart streams (guarded — no races)
    const mergedState = [...this._states.values()][0];
    const seedStates = new Map<string, Schema>();
    if (mergedState) {
      await Promise.all(
        guarded
          .filter((s) => targetMap.get(s)?.restart)
          .map(async (stream) => {
            const snap = await es.load(mergedState, stream);
            seedStates.set(stream, snap.state as Schema);
          })
      );
    }

    // 6. Archive — per-stream callback while guarded
    for (const stream of guarded) {
      const archiveFn = targetMap.get(stream)?.archive;
      if (archiveFn) await archiveFn();
    }

    // 7. Truncate + seed — atomic per store transaction.
    //    Seed meta traces back to the guard tombstone via causation.event.
    const truncTargets = guarded.map((stream) => {
      const snapshot = seedStates.get(stream);
      const guard = guardEvents.get(stream)!;
      return {
        stream,
        snapshot,
        meta: {
          correlation,
          causation: {
            event: {
              id: guard.id,
              name: TOMBSTONE_EVENT,
              stream: guard.stream,
            },
          },
        },
      };
    });
    const truncated = await store().truncate(truncTargets);

    // 8. Cache invalidate / warm — use real event IDs from committed events
    await Promise.all(
      guarded.map(async (stream) => {
        const entry = truncated.get(stream);
        const state = seedStates.get(stream);
        if (state && entry) {
          await cache().set(stream, {
            state,
            version: entry.committed.version,
            event_id: entry.committed.id,
            patches: 0,
            snaps: 1,
          });
        } else {
          await cache().invalidate(stream);
        }
      })
    );

    // 9. Emit lifecycle event
    const result: CloseResult = { truncated, skipped };
    this.emit("closed", result);
    return result;
  }

  /**
   * Debounced, non-blocking correlate→drain cycle.
   *
   * Call this after `app.do()` to schedule a background drain. Multiple rapid
   * calls within the debounce window are coalesced into a single cycle. Runs
   * correlate→drain in a loop until the system reaches a consistent state,
   * then emits the `"settled"` lifecycle event.
   *
   * @param options - Settle configuration options
   * @param options.debounceMs - Debounce window in milliseconds (default: 10)
   * @param options.correlate - Query filter for correlation scans (default: `{ after: -1, limit: 100 }`)
   * @param options.maxPasses - Maximum correlate→drain loops (default: 1)
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
    const {
      debounceMs = 10,
      correlate: correlateQuery = { after: -1, limit: 100 },
      maxPasses = 1,
      ...drainOptions
    } = options;

    if (this._settle_timer) clearTimeout(this._settle_timer);
    this._settle_timer = setTimeout(() => {
      this._settle_timer = undefined;
      if (this._settling) return;
      this._settling = true;

      (async () => {
        await this._init_correlation();
        let lastDrain: Drain<TEvents> | undefined;
        for (let i = 0; i < maxPasses; i++) {
          const { subscribed } = await this.correlate({
            ...correlateQuery,
            after: this._correlation_checkpoint,
          });
          if (subscribed === 0 && i > 0) break;
          lastDrain = await this.drain(drainOptions);
          if (!lastDrain.acked.length && !lastDrain.blocked.length) break;
        }
        if (lastDrain) this.emit("settled", lastDrain);
      })()
        .catch((err) => logger.error(err))
        .finally(() => {
          this._settling = false;
        });
    }, debounceMs);
  }
}
