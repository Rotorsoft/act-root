import EventEmitter from "node:events";
import { register_weak_disposer } from "./disposers.js";
import { type AuditDeps, audit } from "./internal/audit.js";
import { CircuitBreaker } from "./internal/circuit-breaker.js";
import {
  ALL_LANES,
  classify_registry,
  type EventLaneSet,
} from "./internal/classify.js";
import {
  CloseLock,
  catch_up_correlation,
  run_close_cycle,
} from "./internal/close-cycle.js";
import {
  DEFAULT_LEASE_MILLIS,
  MAX_SHUTDOWN_GRACE_MS,
  resolveAutocloseConfig,
  resolveCircuitBreakerConfig,
  resolveDrainConfig,
  resolveSettleConfig,
  resolveShutdownConfig,
} from "./internal/config.js";
import { CorrelateCycle } from "./internal/correlate-cycle.js";
import {
  close_correlation,
  default_correlator,
} from "./internal/correlation-id.js";
import {
  DrainController,
  type Handle,
  type HandleBatch,
  merge_drains,
} from "./internal/drain-cycle.js";
import type { DrainOps } from "./internal/drain-ops.js";
import { bare_patch, type EsOps, scan } from "./internal/event-sourcing.js";
import {
  FOLD_RESET,
  type ResettableBatchHandler,
} from "./internal/projection-fold.js";
import {
  build_handle,
  build_handle_batch,
} from "./internal/reaction-dispatch.js";
import { SettleLoop } from "./internal/settle.js";
import { build_drain, build_es } from "./internal/tracing.js";
import { walk_streams } from "./internal/walk-streams.js";
import { cache, default_scope, log, store } from "./ports.js";
import {
  current_reacting,
  make_reaction_scope,
  make_run_scoped,
} from "./scoped.js";
import {
  type ActLifecycleEvents,
  type ActOptions,
  type CircuitState,
  DEFAULT_MAX_SUBSCRIBED_STREAMS,
  DEFAULT_SETTLE_DEBOUNCE_MS,
  type Scoped,
} from "./types/act.js";
import { StoreError } from "./types/errors.js";
import type {
  Actor,
  AsOf,
  AuditCategory,
  AuditFinding,
  AuditOptions,
  BatchHandler,
  BlockedLease,
  CloseResult,
  CloseTarget,
  Committed,
  Correlator,
  DoOptions,
  Drain,
  DrainOptions,
  EventSink,
  EventSource,
  IAct,
  LaneConfig,
  Lease,
  LoadTarget,
  Logger,
  PatchFn,
  Query,
  Registry,
  ScanOptions,
  ScanResult,
  Schema,
  SchemaRegister,
  Schemas,
  SettleOptions,
  ShutdownOptions,
  Snapshot,
  State,
  Store,
  StreamFilter,
  StreamPosition,
  Target,
} from "./types/index.js";

/** Reject `onlyLanes` entries that reference undeclared lanes. */
function validate_only_lanes(
  options: ActOptions,
  lanes: ReadonlyArray<LaneConfig>
): void {
  if (!options.onlyLanes || options.onlyLanes.length === 0) return;
  const declared = new Set<string>(["default", ...lanes.map((l) => l.name)]);
  const unknown = options.onlyLanes.filter((l) => !declared.has(l));
  if (unknown.length > 0)
    throw new Error(
      `ActOptions.onlyLanes references undeclared lane(s): ${unknown
        .map((l) => `"${l}"`)
        .join(", ")}`
    );
}

/**
 * @category Orchestrator
 * @see Store
 *
 * The orchestrator: executes actions, loads state, queries events, and runs
 * the reactions each commit frees (on its own, unless `autoSettle: false`).
 *
 * ```typescript
 * const app = act().withState(Counter).build();
 * await app.do("increment", { stream: "counter1", actor }, { by: 1 });
 * const snapshot = await app.load(Counter, "counter1");
 * ```
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
> implements IAct<TEvents, TActions, TActor, TSchemaReg>
{
  private _emitter = new EventEmitter();
  private readonly _breaker: CircuitBreaker;
  private readonly _drain: boolean;
  private readonly _auto_settle: boolean;
  /** Whether any event has a reaction; nothing arms without one. */
  private readonly _reactive: boolean;
  private readonly _drain_controllers: Map<
    string,
    DrainController<TEvents, TActions, TSchemaReg>
  >;
  private readonly _correlate: CorrelateCycle<TSchemaReg, TEvents, TActions>;
  private readonly _settle: SettleLoop<TEvents>;
  private _poll: ReturnType<typeof setInterval> | undefined;
  /** The poll's correlate `limit`, used by every settle pass while it runs. */
  private _poll_limit: number | undefined;
  /**
   * Wired at construction against the store current then, so a store
   * injected after `build()` is never notified.
   */
  private readonly _notify_disposer: Promise<
    (() => void | Promise<void>) | undefined
  >;
  /** Public registry — kept as-is per the no-prefix-on-public convention. */
  public readonly registry: Registry<
    TSchemaReg,
    TEvents,
    TActions,
    keyof TStateMap & string
  >;
  private readonly _states: Map<string, State<any, any, any>>;
  /**
   * Emit a lifecycle event. The payload type is inferred from the event name
   * via {@link ActLifecycleEvents}.
   *
   * Each listener is contained on its own: a throwing listener is logged,
   * the remaining listeners still run, and the caller (`do()`, `forget()`,
   * `close()`, the drain) never sees the throw, since its durable work has
   * already landed.
   *
   * Uses `rawListeners` so `once` wrappers still de-register themselves, and
   * returns "had listeners" to preserve the `EventEmitter.emit` contract.
   */
  emit<E extends keyof ActLifecycleEvents<TSchemaReg, TEvents, TActions>>(
    event: E,
    args: ActLifecycleEvents<TSchemaReg, TEvents, TActions>[E]
  ): boolean {
    const listeners = this._emitter.rawListeners(event as string);
    for (const listener of listeners) {
      try {
        listener(args);
      } catch (error) {
        this._logger.error(error, `${String(event)} listener threw`);
      }
    }
    return listeners.length > 0;
  }

  /**
   * The one place a store failure is logged and emitted (the breaker's
   * `on_error`). The emit is guarded: an unhandled `"error"` emission
   * would crash the process.
   */
  private _emit_error(error: unknown, circuit: CircuitState): void {
    this._logger.error(error);
    if (this._emitter.listenerCount("error") > 0)
      this.emit("error", { error, circuit });
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

  private readonly _batch_handlers: Map<string, BatchHandler<TEvents>>;
  private readonly _es: EsOps;
  private readonly _cd: DrainOps<TEvents>;
  /** Unambiguous: merge rejects an event name declared by two states. */
  private readonly _event_to_state: ReadonlyMap<string, State<any, any, any>>;
  /** Lanes to arm per event; `"all"` when a dynamic resolver hides the lane. */
  private readonly _event_to_lanes: ReadonlyMap<string, EventLaneSet>;
  private readonly _audit_deps: AuditDeps;
  private readonly _logger: Logger = log();
  /** This Act's ports: its own bag, or the singleton adapters. */
  private readonly _ports: Scoped;
  /** Runs a body so internal `store()`/`cache()` calls resolve to `_ports`. */
  private readonly _scoped: <T>(fn: () => Promise<T>) => Promise<T>;

  private readonly _correlator: Correlator;
  private readonly _lanes: ReadonlyArray<LaneConfig>;

  private readonly _close_lock = new CloseLock();
  /** Every lane a controller can exist for: `"default"` plus each declared one. */
  private readonly _declared_lanes: ReadonlyArray<string>;

  /** Drain lanes declared via `.withLane(...)`. Implicit default not included. */
  get lanes(): ReadonlyArray<LaneConfig> {
    return this._lanes;
  }

  /** Use the {@link act} builder rather than constructing directly. */
  constructor(
    registry: Registry<TSchemaReg, TEvents, TActions, keyof TStateMap & string>,
    states: Map<string, State<any, any, any>> = new Map(),
    batch_handlers: Map<string, BatchHandler<any>> = new Map(),
    options: ActOptions = {},
    lanes: ReadonlyArray<LaneConfig> = [],
    patch_fn: PatchFn = bare_patch
  ) {
    this.registry = registry;
    this._states = states;
    this._batch_handlers = batch_handlers;
    this._lanes = lanes;
    this._declared_lanes = ["default", ...lanes.map((l) => l.name)];
    validate_only_lanes(options, lanes);
    // Every Act runs in its own ports frame (the singletons when unscoped),
    // so a shared Act never inherits its caller's frame.
    this._ports = options.scoped ?? default_scope();
    const ports = this._ports;
    this._scoped = make_run_scoped({
      // Getters, not a spread: the singletons resolve lazily, so a later
      // `store(...)` / `cache(...)` still takes effect.
      get store() {
        return ports.store;
      },
      get cache() {
        return ports.cache;
      },
      // Parsed per build, so a bad window throws on every build.
      autoclose_window: resolveAutocloseConfig(options).autocloseWindow,
    });
    this._correlator = options.correlator ?? default_correlator;
    this._es = build_es(this._logger, this._correlator, patch_fn);
    this._cd = build_drain<TEvents>(this._logger);
    // PII stripping is wrapped around handlers at build time, so the
    // dispatcher is PII-unaware. Bound once, reused by every reaction payload.
    const handle = build_handle<TEvents, TActions, TActor>({
      logger: this._logger,
      reaction_scope: make_reaction_scope({
        do: this.do.bind(this),
        load: this.load.bind(this),
        query: this.query.bind(this),
        query_array: this.query_array.bind(this),
        forget: this.forget.bind(this),
      }),
    });
    const handle_batch = build_handle_batch<TEvents>(this._logger);

    const classification = classify_registry(this.registry, this._states);
    this._reactive = classification.event_to_lanes.size > 0;
    this._event_to_state = classification.event_to_state;
    this._event_to_lanes = classification.event_to_lanes;
    this._drain = options.drain !== false;
    this._auto_settle = options.autoSettle !== false;

    // Order matters: controllers read the breaker, the audit bag reads the
    // controller set, settle reads the correlate cycle.
    this._breaker = this._build_breaker(options);
    this._drain_controllers = this._build_drain_controllers(
      options,
      lanes,
      handle,
      handle_batch
    );
    this._advise_orphaned_lanes(options);
    this._audit_deps = this._build_audit_deps();
    this._correlate = this._build_correlate(options, classification);
    this._settle = this._build_settle(options);

    // Wire cross-process notify against the store current at construction.
    this._notify_disposer = this._wire_notify(
      this._ports.store,
      options.listen !== false
    );

    // Registered weakly, so `dispose()()` reaches a live Act while an
    // unreachable one (per tenant, per test) can still be collected.
    register_weak_disposer(new WeakRef(this), (self) => self.shutdown());
  }

  /** Shared by drain, settle and autoclose; bad knobs throw at build. */
  private _build_breaker(options: ActOptions): CircuitBreaker {
    return new CircuitBreaker(
      resolveCircuitBreakerConfig(options.circuitBreaker),
      {
        on_error: (error, circuit) => this._emit_error(error, circuit),
        // When the cooldown elapses, settle once: its scan or claim is the
        // half-open probe that closes or re-opens the breaker.
        on_retry: () => this._schedule(),
      }
    );
  }

  /** Apps that declare no lanes pass no lane filter to `claim`. */
  private _build_drain_controllers(
    options: ActOptions,
    lanes: ReadonlyArray<LaneConfig>,
    handle: Handle<TEvents>,
    handle_batch: HandleBatch<TEvents>
  ): Map<string, DrainController<TEvents, TActions, TSchemaReg>> {
    const all_lanes = this._declared_lanes;
    const only_set =
      options.onlyLanes && options.onlyLanes.length > 0
        ? new Set<string>(options.onlyLanes as readonly string[])
        : undefined;
    const active_lanes = only_set
      ? all_lanes.filter((n) => only_set.has(n))
      : all_lanes;
    // Decided by the declared lanes, not the active ones: a worker narrowed
    // to "default" must still filter, or it would claim every lane.
    const single_default_lane = lanes.length === 0;
    const controllers = new Map<
      string,
      DrainController<TEvents, TActions, TSchemaReg>
    >();
    for (const name of active_lanes) {
      const cfg = lanes.find((l) => l.name === name);
      const controller = new DrainController({
        logger: this._logger,
        ops: this._cd,
        registry: this.registry,
        batch_handlers: this._batch_handlers,
        handle,
        handle_batch,
        on_acked: (acked) => this.emit("acked", acked),
        on_blocked: (blocked) => this.emit("blocked", blocked),
        // Reaction-requested close: the same machinery as `app.close`.
        // A store failure reaches the breaker; anything else (the archive
        // callback is app code) is logged here, never counted.
        on_close: async (targets) => {
          try {
            await this._run_close(targets);
          } catch (error) {
            if (error instanceof StoreError) throw error;
            this._logger.error(
              error,
              `Reaction-requested close of ${targets.map((t) => `"${t.stream}"`).join(", ")} failed and was not retried; close it with app.close(...) once the cause is fixed.`
            );
          }
        },
        breaker: this._breaker,
        run_scoped: this._scoped,
        lane: single_default_lane ? undefined : name,
        defaults: cfg && {
          streamLimit: cfg.streamLimit,
          leaseMillis: cfg.leaseMillis,
        },
      });
      // A lane with `cycleMs` drives itself on that timer (not on
      // writer-only instances).
      if (cfg?.cycleMs !== undefined && options.drain !== false)
        controller.start(cfg.cycleMs);
      controllers.set(name, controller);
    }
    return controllers;
  }

  /** One process can't see the cluster, so it reports its own lane gaps. */
  private _advise_orphaned_lanes(options: ActOptions): void {
    if (!options.onlyLanes || options.onlyLanes.length === 0) return;
    const active = new Set(this._drain_controllers.keys());
    const orphaned = this._declared_lanes.filter((name) => !active.has(name));
    if (orphaned.length === 0) return;
    const list = orphaned.map((name) => `"${name}"`).join(", ");
    this._logger.info(
      `Act declared ${orphaned.length} orphaned lane(s) on this instance: ${list}. ` +
        `onlyLanes excludes them, so no DrainController claims their streams here — ` +
        `their reactions accumulate un-drained unless a peer worker deploys with these ` +
        `lanes in its onlyLanes. Ensure the cluster invariant holds: the union of every ` +
        `worker's onlyLanes must cover every declared lane. ` +
        `See docs/docs/guides/production-checklist.md § Sizing lanes.`
    );
  }

  /** Audit deps, built after the controllers so the lane set is final. */
  private _build_audit_deps(): AuditDeps {
    return {
      store,
      event_to_state: this._event_to_state,
      // Declared lanes, not this process's controllers: a lane another
      // worker drains is not `unknown-lane`.
      declared_lanes: new Set(this._declared_lanes),
      routed_events: new Set(this._event_to_lanes.keys()),
    };
  }

  private _build_correlate(
    options: ActOptions,
    classification: ReturnType<
      typeof classify_registry<TSchemaReg, TEvents, TActions>
    >
  ): CorrelateCycle<TSchemaReg, TEvents, TActions> {
    return new CorrelateCycle({
      registry: this.registry,
      static_targets: classification.static_targets,
      cd: this._cd,
      breaker: this._breaker,
      max_subscribed_streams:
        options.maxSubscribedStreams ?? DEFAULT_MAX_SUBSCRIBED_STREAMS,
      // Declared lanes (not active ones): a lane another process claims is
      // still a valid destination.
      declared_lanes: new Set(this._declared_lanes),
      // Built after the controllers, so their keys are the active lanes.
      shard:
        this._drain_controllers.size < this._declared_lanes.length
          ? [...this._drain_controllers.keys()]
          : undefined,
      // Only reached on a draining app: writer-only ones never correlate.
      on_init: async () => {
        this._arm_all();
        await this._seed_persisted_defers();
      },
    });
  }

  /** Cold start: an idle deferred stream still fires on time after a restart. */
  private async _seed_persisted_defers(): Promise<void> {
    const now = Date.now();
    await walk_streams(store(), (pos) => {
      // A past-due schedule is already claimable.
      if (pos.deferred_at === undefined || pos.deferred_at <= now) return;
      const controller = this._drain_controllers.get(pos.lane ?? "default");
      controller?.seed_defer(pos.stream, pos.deferred_at);
    });
  }

  private _build_settle(options: ActOptions): SettleLoop<TEvents> {
    return new SettleLoop<TEvents>(
      {
        correlate: (q) =>
          this._correlate_pass(
            { ...q, limit: q.limit ?? this._poll_limit ?? 100 },
            true
          ),
        // `settle()` validated the options, and `_schedule` skips writer-only
        // instances, so the loop drains through the internal path.
        drain: (o) => this._scoped(() => this._drain_all(o)),
        on_settled: (drain) => this.emit("settled", drain),
      },
      options.settleDebounceMs ?? DEFAULT_SETTLE_DEBOUNCE_MS
    );
  }

  private _shutdown_promise: Promise<void> | undefined;

  /**
   * Per-instance teardown: stops scheduling, removes the notify
   * subscription, gives the cycles in flight up to `graceMs` to reach their
   * `ack` (an abandoned handler holds its lease until it expires), then
   * hands back the correlation lease and removes listeners.
   * The budget is a ceiling, not a delay.
   *
   * Idempotent: repeated calls return the same promise, with the first
   * call's `graceMs`. Registered with the global `dispose()` registry, so
   * `dispose()()` covers it; call it directly for prompt cleanup.
   *
   * @param options - See {@link ShutdownOptions}. Defaults the grace budget
   *   to the largest lane `leaseMillis` (capped at 30s).
   */
  shutdown(options?: ShutdownOptions): Promise<void> {
    if (!this._shutdown_promise) {
      resolveShutdownConfig(options);
      this._shutdown_promise = (async () => {
        // Stop every scheduler before awaiting anything slow, so nothing
        // starts while the notify subscription comes down. The lease is
        // handed back once, at the end.
        this._stop_poll();
        this._settle.stop(true);
        this._breaker.stop();
        for (const c of this._drain_controllers.values()) c.stop();
        // Never rejects.
        const disposer = await this._notify_disposer;
        if (disposer) await disposer();
        await this._await_inflight(options?.graceMs);
        // Hand the correlation lease back last, after the wait (a settle
        // cycle still running would re-take it), and await it so a
        // successor isn't refused.
        await this._scoped(() => this._correlate.release_correlation());
        this._emitter.removeAllListeners();
      })();
    }
    return this._shutdown_promise;
  }

  /**
   * The largest `leaseMillis` among lanes with a cycle in flight (the
   * default for none or 0, and for a running settle), capped.
   */
  private _derive_grace_ms(
    running: { readonly lease_millis: number | undefined }[],
    settling: boolean
  ): number {
    // A lane with no lease waits the drain's default lease: as long as its
    // handlers were already allowed to hold a stream.
    let max = settling ? DEFAULT_LEASE_MILLIS : 0;
    for (const c of running)
      max = Math.max(max, c.lease_millis || DEFAULT_LEASE_MILLIS);
    return Math.min(max, MAX_SHUTDOWN_GRACE_MS);
  }

  private async _await_inflight(grace_ms?: number): Promise<void> {
    const running = [...this._drain_controllers.values()].filter(
      (c) => c.inflight !== undefined
    );
    // A settle cycle already running keeps going after `stop()`, so wait
    // for it too.
    const settling = this._settle.inflight;
    if (running.length === 0 && !settling) return;
    const grace = grace_ms ?? this._derive_grace_ms(running, !!settling);
    if (grace <= 0) return;
    const inflight = running.map((c) => c.inflight);
    if (settling) inflight.push(settling);
    let timer!: ReturnType<typeof setTimeout>;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, grace);
      timer.unref();
    });
    try {
      await Promise.race([Promise.all(inflight), budget]);
    } finally {
      // Don't leave the budget timer pending when the cycles won the race.
      clearTimeout(timer);
    }
  }

  /** Failures are logged, never thrown: `notify` is a hint. */
  private async _wire_notify(
    s: Store,
    listen: boolean
  ): Promise<(() => void | Promise<void>) | undefined> {
    if (!this._reactive) return undefined;
    if (!s.notify) return undefined;
    // Only the subscriber side is gated; commits still notify.
    if (!listen) return undefined;
    try {
      return await s.notify((notification) => {
        // Errors are logged and swallowed so the store's listener survives.
        try {
          this.emit("notified", notification);
          this._wake(notification.events.map((e) => e.name));
        } catch (err) {
          this._logger.error(err, "notified handler threw");
        }
      });
    } catch (err) {
      this._logger.error(err, "Store.notify subscription failed");
      return undefined;
    }
  }

  /**
   * Executes an action: validates the payload, loads the state, checks its
   * invariants, and commits the events its handler emits, with optimistic
   * concurrency on the stream. The reactions to those events settle on
   * their own (unless `autoSettle: false`).
   *
   * @template TKey - Action name from registered actions
   * @param action - The name of the action to execute
   * @param target - Target specification with stream ID and actor context
   * @param payload - Action payload matching the action's schema
   * @param options - Per-call dispatch options ({@link DoOptions}) —
   *   `reactingTo` to thread correlation, `correlator` to override the
   *   framework or orchestrator-level correlator for this call only.
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
   * @see {@link Target} for target structure
   * @see {@link Snapshot} for return value structure
   * @see {@link ValidationError}, {@link InvariantError}, {@link ConcurrencyError}
   */
  async do<TKey extends keyof TActions>(
    action: TKey,
    target: Target<TActor>,
    payload: Readonly<TActions[TKey]>,
    options?: DoOptions<TEvents>
  ) {
    // Resolve the ambient reaction context here so `internal/` never reads
    // ambient state. An explicit `reactingTo` wins.
    const reacting_to = options?.reactingTo ?? current_reacting();
    const do_options =
      reacting_to === options?.reactingTo
        ? options
        : { ...options, reactingTo: reacting_to };
    return this._scoped(async () => {
      const snapshots = await this._es.action(
        this.registry.actions[action],
        action,
        target,
        payload,
        do_options
      );
      // A local commit runs its reactions the way a remote one does
      // (`action()` snapshots always carry their event).
      this._wake(snapshots.map((s) => (s.event as { name: string }).name));
      this.emit("committed", snapshots);
      return snapshots;
    });
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
   * @see {@link Snapshot} for snapshot structure
   */
  // Anonymous load (bare stream) — sensitive fields come back as REDACTED.
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
  // Auth-aware load — runs `.discloses(predicate)` against the supplied actor.
  async load<
    TNewState extends Schema,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
  >(
    state: State<TNewState, TNewEvents, TNewActions>,
    target: LoadTarget<TActor>,
    callback?: (snapshot: Snapshot<TNewState, TNewEvents>) => void
  ): Promise<Snapshot<TNewState, TNewEvents>>;
  async load<TKey extends keyof TStateMap & string>(
    name: TKey,
    target: LoadTarget<TActor>,
    callback?: (snapshot: Snapshot<TStateMap[TKey], TEvents>) => void
  ): Promise<Snapshot<TStateMap[TKey], TEvents>>;
  async load<TNewState extends Schema>(
    stateOrName: State<TNewState, any, any> | string,
    streamOrTarget: string | LoadTarget<TActor>,
    callback?: (snapshot: Snapshot<any, any>) => void,
    asOf?: AsOf
  ): Promise<Snapshot<any, any>> {
    return this._scoped(async () => {
      let merged: State<any, any, any>;
      if (typeof stateOrName === "string") {
        const found = this._states.get(stateOrName);
        if (!found) throw new Error(`State "${stateOrName}" not found`);
        merged = found;
      } else {
        merged = this._states.get(stateOrName.name) || stateOrName;
      }
      // Normalize the two surfaces: bare-stream (default-deny — actor
      // undefined → REDACTED on the discloses check) vs LoadTarget
      // (auth-aware — actor flows into `.discloses(predicate)`).
      const target: LoadTarget<Actor> =
        typeof streamOrTarget === "string"
          ? {
              stream: streamOrTarget,
              actor: undefined as unknown as Actor,
              asOf,
            }
          : streamOrTarget;
      return await this._es.load(merged, target, callback);
    });
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
   * @param query - Filter criteria; see {@link Query} for the fields
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
    return this._scoped(async () => {
      let first: Committed<TEvents, keyof TEvents> | undefined;
      let last: Committed<TEvents, keyof TEvents> | undefined;
      const count = await store().query<TEvents>((e) => {
        const gated = this.registry.query_gate(e.name as string)(e);
        if (!first) first = gated;
        last = gated;
        callback?.(gated);
      }, query);
      return { first, last, count };
    });
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
   * @see {@link query} for large result sets
   */
  async query_array(
    query: Query
  ): Promise<Committed<TEvents, keyof TEvents>[]> {
    return this._scoped(async () => {
      const events: Committed<TEvents, keyof TEvents>[] = [];
      await store().query<TEvents>((e) => {
        events.push(this.registry.query_gate(e.name as string)(e));
      }, query);
      return events;
    });
  }

  /**
   * Wipe the sensitive-data payload for every event on the stream — see
   * {@link IAct.forget}.
   *
   * Throws on adapters without `Store.forget_pii`, invalidates the cache
   * entry for the stream, emits the `forgotten` lifecycle event with the
   * row count. Idempotent: a second call returns `{eventCount: 0}` and
   * does NOT re-emit.
   *
   * @param stream - Target stream.
   * @returns `{eventCount}` — number of events whose PII column was wiped.
   */
  async forget(stream: string): Promise<{ eventCount: number }> {
    return this._scoped(async () => {
      const s = store();
      if (!s.forget_pii) {
        throw new Error(
          `Store does not implement forget_pii — adapter cannot comply with sensitive-data erasure. ` +
            `Use an adapter that declares pii_isolation: true (e.g. @rotorsoft/act on the in-memory store).`
        );
      }
      const eventCount = await s.forget_pii(stream);
      await cache().invalidate(stream);
      if (eventCount > 0) {
        this.emit("forgotten", { stream, at: new Date(), eventCount });
      }
      return { eventCount };
    });
  }

  /**
   * Runs one drain cycle: claims streams with marked work (leasing them),
   * fetches their events, runs the matching reactions, and acks or blocks
   * each stream.
   *
   * A stream is claimable only once `correlate()` has marked it, static
   * targets included, so a commit no correlate has seen is not drainable.
   * Apps rarely call this: each commit settles its reactions on its own.
   * With `autoSettle: false`, tests walk the pipeline with `correlate()`
   * then `drain()` (see the testing guide).
   *
   * @param options - Drain configuration — see {@link DrainOptions} for fields
   *   (`streamLimit`, `eventLimit`, `leaseMillis`).
   * @returns Drain statistics with fetched, leased, acked, and blocked counts
   *
   * @example Walking the pipeline in a test
   * ```typescript
   * const app = act().withState(User).withProjection(Users).build({ autoSettle: false });
   * await app.do("createUser", target, payload);
   * await app.correlate();
   * await app.drain();
   * ```
   *
   * @see {@link settle} for debounced correlate→drain with lifecycle events
   * @see {@link correlate} for dynamic stream discovery
   */
  async drain(options: DrainOptions = {}): Promise<Drain<TEvents>> {
    // Validate the runtime knobs before anything runs (a bad leaseMillis /
    // streamLimit / eventLimit throws ZodError here, not on the first cycle).
    resolveDrainConfig(options);
    // Writer-only instances run no reactions.
    if (!this._drain)
      return { fetched: [], leased: [], acked: [], blocked: [] };
    return this._scoped(() => this._drain_all(options));
  }

  /** Arms correlate and every lane; false on an app with no reactions. */
  private _arm_all(): boolean {
    if (!this._reactive) return false;
    // A commit may also give the next correlate scan something to find.
    this._correlate.arm();
    for (const c of this._drain_controllers.values()) c.arm();
    return true;
  }

  /**
   * Wakes what a change freed (a commit, a reset, an unblock, a restore,
   * a notification from another process): arms the lanes these events
   * react on, or every lane without names, and settles them unless the app
   * walks the pipeline itself (`autoSettle: false`).
   */
  private _wake(names?: Iterable<string>): void {
    const armed = names ? this._arm_for_event_names(names) : this._arm_all();
    if (armed && this._auto_settle) this._schedule();
  }

  /** Schedules a settle pass; writer-only instances (`drain: false`) skip it. */
  private _schedule(options?: SettleOptions): void {
    if (this._drain) this._settle.schedule(options);
  }

  /** Arms only the lanes these events react on; true when any was armed. */
  private _arm_for_event_names(names: Iterable<string>): boolean {
    const to_arm = new Set<string>();
    for (const name of names) {
      const set = this._event_to_lanes.get(name);
      if (set === undefined) continue;
      if (set === ALL_LANES) {
        this._arm_all();
        return true;
      }
      for (const lane of set) to_arm.add(lane);
    }
    if (to_arm.size === 0) return false;
    this._correlate.arm();
    for (const lane of to_arm) this._drain_controllers.get(lane)?.arm();
    return true;
  }

  /** In parallel, so a slow lane never holds up a fast one. */
  private async _drain_all(options: DrainOptions): Promise<Drain<TEvents>> {
    const merged = merge_drains(
      await Promise.all(
        [...this._drain_controllers.values()].map((c) => c.drain(options))
      )
    );
    // Actor-less like `query`/`query_array`, so default-deny.
    // Handlers are unaffected — they read through their own strip.
    return {
      ...merged,
      fetched: merged.fetched.map((f) => ({
        ...f,
        events: f.events.map((e) =>
          this.registry.query_gate(e.name as string)(e)
        ),
      })),
    };
  }

  /**
   * Scans committed events from the correlation checkpoint, subscribes the
   * target streams their reactions resolve to (static or computed from
   * the event), and marks their work so the next drain can claim it.
   *
   * @param query - Scan filter — see {@link Query} for fields (typically
   *   `{ limit: <count> }`; the scan starts at the checkpoint)
   * @returns The number of newly subscribed streams and the last scanned event id
   *
   * @example Manual correlation
   * ```typescript
   * const { subscribed } = await app.correlate({ limit: 100 });
   * ```
   *
   * @see {@link start_correlations} for automatic periodic correlation
   */
  async correlate(
    query: Query = { after: -1, limit: 10 }
  ): Promise<{ subscribed: number; last_id: number }> {
    const { subscribed } = await this._correlate_pass(query);
    return { subscribed, last_id: this._correlate.checkpoint };
  }

  /** One correlate pass; arms the lanes when it found work. */
  private async _correlate_pass(
    query: Query,
    /** Honour the correlation lease — settle and the poller only. */
    lease = false
  ): Promise<{ subscribed: number; read: boolean }> {
    // Writer-only instances don't correlate.
    if (!this._drain) return { subscribed: 0, read: false };
    return this._scoped(async () => {
      const { subscribed, read, marked } = await this._correlate.correlate(
        query,
        lease
      );
      // Also re-arms correlate, so a backlog scan keeps going.
      if (subscribed > 0 || marked > 0) this._arm_all();
      return { subscribed, read };
    });
  }

  /**
   * Starts a background poll that settles on a timer: each tick looks for
   * new events, subscribes the streams their reactions target, and drains
   * them, along with any stream whose lease a dead worker let expire.
   *
   * Use it when this process can miss commits — another process writes to a
   * store without `notify`, or a notification is lost. It is the safety net
   * under `notify`: a missed wakeup costs at most one `frequency` of latency.
   *
   * Only one poll runs per Act instance. On a writer-only instance
   * (`drain: false`) each tick is a no-op, like `settle()`.
   *
   * @param query - Only `limit` is used: the most events each correlate pass
   *   reads (default 100). The scan always starts at the correlation
   *   checkpoint, so `after` is ignored.
   * @param frequency - Milliseconds between ticks (default: 10000)
   * @returns `true` if the poll started, `false` if one is already running
   *
   * @example
   * ```typescript
   * app.start_correlations({ limit: 100 }, 5000);
   * // later
   * app.stop_correlations();
   * ```
   *
   * @see {@link settle} for what each tick runs
   * @see {@link stop_correlations} to stop the poll
   */
  start_correlations(query: Query = {}, frequency = 10_000): boolean {
    if (this._poll) return false;
    this._poll_limit = query.limit || undefined;
    this._poll = setInterval(() => {
      // No local signal says there is work, so look anyway: correlate for
      // new events, and every lane for leases that came free (a dead
      // worker's expired lease is claimable, but no commit will say so).
      this._arm_all();
      this._schedule();
    }, frequency);
    return true;
  }

  /**
   * Stops the poll started by {@link start_correlations}. Idempotent, and
   * called by `shutdown()`.
   *
   * @see {@link start_correlations}
   */
  stop_correlations() {
    this._stop_poll();
    // Hand the correlation lease back, best-effort and not awaited (this
    // method is synchronous; the lease would expire anyway).
    void this._scoped(() => this._correlate.release_correlation());
  }

  private _stop_poll(): void {
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = undefined;
      this._poll_limit = undefined;
    }
  }

  /**
   * Drops the settle pass scheduled but not yet started. A cycle already
   * running finishes; later changes schedule new passes.
   *
   * @see {@link settle}
   */
  stop_settling() {
    this._settle.stop();
  }

  /**
   * Reset reaction stream watermarks and settle them, replaying their
   * events through their reactions.
   *
   * Use this to replay events through projections (or other reaction targets)
   * after changing handler logic. It rewinds the same watermarks as
   * `store().reset(streams)`, and also wakes the drain and schedules a
   * settle, which loops correlate→drain until the replay catches up;
   * `store().reset(...)` alone leaves a settled app idle. Call
   * `app.settle(options)` right after to give that pass batch options, or,
   * with `autoSettle: false`, `correlate()` / `drain()` to drive the replay
   * by hand.
   *
   * @param input - Reaction target streams (e.g., projection names) to reset, or a {@link StreamFilter} for bulk operations
   * @returns Count of streams that were actually reset
   *
   * @example Rebuild a projection (production)
   * ```typescript
   * await app.reset(["my-projection"]);
   * app.settle({ eventLimit: 1000 }); // optional: bigger batches; emits "settled"
   * ```
   *
   * @see {@link Store.reset} for the underlying store primitive
   * @see {@link settle} for the debounced full-catch-up loop
   */
  async reset(input: string[] | StreamFilter): Promise<number> {
    return this._scoped(async () => {
      const count = await store().reset(input);
      // Drop every fold cache before the replay, or a warm cache would
      // re-flush stale rows. Cleared for all targets: resolving `input`
      // costs a query, and an extra clear costs one head load per stream.
      for (const handler of this._batch_handlers.values())
        (handler as ResettableBatchHandler<TEvents>)[FOLD_RESET]?.();
      if (count > 0) {
        this._wake();
      }
      return count;
    });
  }

  /**
   * Clear the blocked flag on streams without replaying their history.
   *
   * Use this to recover from a poison message after fixing the
   * underlying issue — the stream resumes from the next event after the
   * last successful ack, not from the beginning. Compare with
   * {@link reset}, which rebuilds from event 0 (suitable for projection
   * rebuilds, wrong for "I fixed the bug, please retry").
   *
   * Wraps `store().unblock(streams)` and settles the now-free streams on
   * its own. `store().unblock(...)` alone leaves them waiting for the next
   * commit.
   *
   * @param input - Stream names to unblock, or a {@link StreamFilter} for bulk recovery
   * @returns Count of streams that were actually flipped (were blocked)
   *
   * @example Recover from a 4xx webhook after fixing the bug
   * ```typescript
   * await app.unblock(["webhooks-out-customer-42"]);
   * // The stream resumes from the next event, not from zero.
   * ```
   *
   * @see {@link Store.unblock} for the underlying store primitive
   * @see {@link reset} for the rebuild-from-zero alternative
   */
  async unblock(input: string[] | StreamFilter): Promise<number> {
    return this._scoped(async () => {
      const count = await store().unblock(input);
      if (count > 0) {
        this._wake();
      }
      return count;
    });
  }

  /**
   * Atomically wipe the store and rebuild it from an event source. The
   * framework owns iteration, validation, `drop_snapshots` filtering,
   * `on_progress`, and the per-call `old → new` causation remap; the
   * adapter's {@link Store.restore} driver supplies the transaction
   * lifecycle and per-event insert.
   *
   * Throws if the adapter has no restore capability. Throws on the
   * first invalid event (negative version, malformed `created`) with
   * the running index in the message; atomic transaction rollback in
   * the adapter means a failing restore leaves the store byte-for-byte
   * unchanged.
   *
   * @param source - Any {@link EventSource}: a `CsvFile` backup or
   *   another store. Read in batches rather than buffered, so
   *   multi-million-event backups don't OOM. Each event's original `id`
   *   is used as a causation lookup key but never written through —
   *   adapters renumber densely.
   * @param opts - {@link ScanOptions}. `drop_snapshots` skips
   *   `__snapshot__` events (counted in the result); `on_progress`
   *   fires once per event.
   * @param sink - Where the events land. Defaults to this Act's store.
   * @returns {@link ScanResult} with `kept`, `duration_ms`, and
   *   `dropped` per-category counters.
   *
   * @example Restore a CSV backup into the connected store
   * ```typescript
   * const result = await app.restore(new CsvFile({ path: "./backup.csv" }));
   * console.log(`Restored ${result.kept} events in ${result.duration_ms}ms`);
   * await cache().clear();   // operator's responsibility
   * ```
   *
   * @see {@link Store.restore} for the underlying driver-pattern primitive.
   */
  async restore(
    source: EventSource,
    opts: ScanOptions = {},
    sink?: EventSink
  ): Promise<ScanResult> {
    return this._scoped(async () => {
      const started = Date.now();
      // Dry-run: count what a restore would land, touching no sink.
      if (opts.dry_run) {
        const partial = await scan(source, opts);
        return { ...partial, duration_ms: Date.now() - started };
      }
      // Default sink is this Act's store.
      const target: EventSink =
        sink ??
        (() => {
          const s = store();
          if (!s.restore) throw new Error("adapter has no restore capability");
          return s as EventSink;
        })();
      let kept = 0;
      let migrated = 0;
      let dropped = { closed_streams: 0, snapshots: 0 };
      await target.restore(async (callback) => {
        const partial = await scan(source, opts, callback);
        kept = partial.kept;
        migrated = partial.migrated;
        dropped = partial.dropped;
      });
      // Restoring into this app's own store replaced its log (new ids, no
      // subscription rows): restart correlation from cold and arm the drain.
      if (!sink) {
        this._correlate.restart();
        this._wake();
      }
      return { kept, migrated, dropped, duration_ms: Date.now() - started };
    });
  }

  /**
   * Return every currently-blocked stream position. Convenience wrapper
   * around `store().query_streams(cb, { blocked: true })` for the common
   * "show me what's broken" operational query.
   *
   * Results are ordered by stream name, paginated by `limit` (default
   * 100). Pass `after` to fetch the next page (keyset cursor on the
   * stream name). For richer queries — including blocked + source
   * filters, or full unblocked introspection — drop to
   * `store().query_streams(...)` directly.
   *
   * @returns Array of {@link StreamPosition} for currently-blocked streams.
   *
   * @example Discover and recover
   * ```typescript
   * const blocked = await app.blocked_streams();
   * console.table(blocked.map(({ stream, retry, error }) => ({ stream, retry, error })));
   *
   * // Operator investigates, then bulk-unblocks the family:
   * await app.unblock({ stream: "^webhooks-out-" });
   * ```
   */
  async blocked_streams(options?: {
    after?: string;
    limit?: number;
  }): Promise<StreamPosition[]> {
    return this._scoped(async () => {
      const positions: StreamPosition[] = [];
      await store().query_streams(
        (p) => {
          positions.push(p);
        },
        { blocked: true, after: options?.after, limit: options?.limit }
      );
      return positions;
    });
  }

  /**
   * Operator-driven store audit: walks the store and yields findings per
   * category, each with the remediation it suggests. Never run by the
   * framework. Pass a subset of categories to scope the work; the iterable
   * can be broken early, and findings stream without buffering the report.
   *
   * @param categories - Subset of categories to run (default: all).
   * @param options - Query window + per-category thresholds.
   * @returns Async iterable of {@link AuditFinding}.
   *
   * @example Schema drift since the last scan
   * ```typescript
   * for await (const f of app.audit(["schema"], { query: { created_after: lastScan } }))
   *   await escalate(f);
   * ```
   */
  async *audit(
    categories?: AuditCategory[],
    options?: AuditOptions
  ): AsyncIterable<AuditFinding> {
    // Step the generator inside `_scoped`: its body runs lazily in the
    // consumer's frame, which would otherwise resolve the wrong store.
    const it = audit(this._audit_deps, categories, options)[
      Symbol.asyncIterator
    ]();
    while (true) {
      const { value, done } = await this._scoped(() => it.next());
      if (done) break;
      yield value;
    }
  }

  /**
   * Sets the scheduling priority of every stream matching `filter`, as-is:
   * unlike build-time priorities (the highest across reactions wins), this
   * overrides them. Useful to let a long replay jump ahead of other lagging
   * streams, or to yield slots back. **An empty filter (`{}`) updates every
   * registered stream.**
   *
   * @param filter - Selection criteria (regex by default, like {@link query}).
   * @param priority - New priority value. Set as-is — no clamp.
   * @returns Count of streams whose priority changed.
   *
   * @example Boost a specific projection mid-replay
   * ```typescript
   * await app.prioritize({ stream: "^proj-orders$", stream_exact: false }, 10);
   * ```
   *
   * @see {@link Store.prioritize} for the underlying primitive
   */
  async prioritize(filter: StreamFilter, priority: number): Promise<number> {
    return this._scoped(() => store().prioritize(filter, priority));
  }

  /** Shared by `close()` and reaction-requested closes. */
  private async _run_close(targets: CloseTarget[]): Promise<CloseResult> {
    const close_actor = { id: "$close", name: "close" };
    const result = await run_close_cycle(targets, {
      reactive: this._reactive,
      catch_up_correlation: (until) =>
        catch_up_correlation(
          this._correlate,
          (limit) => this.correlate({ limit }),
          until
        ),
      event_to_state: this._event_to_state,
      load: this._es.load,
      tombstone: this._es.tombstone,
      logger: this._logger,
      correlation: close_correlation(this._correlator, close_actor),
      with_stream_lock: (stream, work) => this._close_lock.run(stream, work),
      forget_subscribed: (streams) =>
        this._correlate.forget_subscribed(streams),
    });
    this.emit("closed", result);
    return result;
  }

  /**
   * Close the books: guard, archive, truncate, and optionally restart
   * streams. A stream with pending reactions is skipped; an archive
   * failure aborts the whole close while the streams are still guarded.
   * Targets carrying `before` prune a rolling window instead and leave the
   * stream live (needs `.snap(...)`). The phases and their failure
   * semantics are in the close-cycle architecture page.
   *
   * @param targets - Per-stream close options (stream, restart?, archive?, before?)
   * @returns `{ truncated: TruncateResult, skipped: string[] }`
   *
   * @example Archive and close
   * ```typescript
   * await app.close([
   *   { stream: "order-123", archive: async () => { await archiveToS3("order-123"); } },
   *   { stream: "order-456" },
   * ]);
   * ```
   */
  async close(targets: CloseTarget[]): Promise<CloseResult> {
    if (!targets.length) return { truncated: new Map(), skipped: [] };

    return this._scoped(() => this._run_close(targets));
  }

  /**
   * Debounced, non-blocking correlate→drain cycle.
   *
   * A local change that frees reaction work (a commit, `reset()`,
   * `unblock()`, `restore()`) schedules this on its own unless the app
   * sets `autoSettle: false`. Call it at startup, to run what was pending
   * before a restart, or with options for the next pass. A pass already
   * scheduled is never put off: calls before it runs join it (a shorter
   * `debounceMs` brings it forward), and a call during a running cycle
   * queues one more pass after it. Runs correlate→drain in a loop until a pass makes no
   * progress — no new subscriptions, no events read, no streams leased —
   * then emits the `"settled"` lifecycle event, so one call fully catches
   * up paginated streams without forcing callers to loop.
   *
   * @param options - Settle configuration — see {@link SettleOptions} for fields:
   *   `debounceMs` (default 10), `correlate.limit` (default 100, or the
   *   poll's limit while `start_correlations` runs; `after` is always the
   *   checkpoint),
   *   `maxPasses` (default `Infinity`; caps this settle's passes, not the
   *   passes a reaction chain's own commits schedule),
   *   `streamLimit` (default 10), `eventLimit` (default 10),
   *   `leaseMillis` (default 10000).
   *
   * @example Startup
   * ```typescript
   * app.settle(); // run what was pending before the restart
   *
   * app.on("settled", (drain) => {
   *   // notify SSE clients, invalidate caches, etc.
   * });
   * ```
   *
   * @see {@link drain} for single synchronous drain cycles
   * @see {@link correlate} for manual correlation
   */
  settle(options?: SettleOptions): void {
    // Validate the runtime knobs before anything runs (a bad debounceMs /
    // leaseMillis / maxPasses throws ZodError here, not on the first pass).
    resolveSettleConfig(options ?? {});
    this._schedule(options);
  }
}
