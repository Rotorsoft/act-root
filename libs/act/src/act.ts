import EventEmitter from "node:events";
import {
  ALL_LANES,
  type AuditDeps,
  audit,
  bare_patch,
  build_drain,
  build_es,
  build_handle,
  build_handle_batch,
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  CorrelateCycle,
  classify_registry,
  close_correlation,
  DrainController,
  type DrainOps,
  default_correlator,
  type EsOps,
  type EventLaneSet,
  type Handle,
  type HandleBatch,
  type PatchFn,
  resolveCircuitBreakerConfig,
  resolveDrainConfig,
  resolveSettleConfig,
  run_close_cycle,
  SettleLoop,
  scan,
} from "./internal/index.js";

// Public re-exports: these appear in ActOptions / ActLifecycleEvents above.
export type { CircuitBreakerOptions, CircuitState } from "./internal/index.js";

import { cache, dispose, log, type Scoped, scoped, store } from "./ports.js";
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
  Query,
  Registry,
  ScanOptions,
  ScanResult,
  Schema,
  SchemaRegister,
  Schemas,
  SettleOptions,
  Snapshot,
  State,
  Store,
  StoreNotification,
  StreamFilter,
  StreamPosition,
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
 * Default debounce window (ms) for `settle()` when neither the per-call
 * `SettleOptions.debounceMs` nor `ActOptions.settleDebounceMs` is set.
 * Coalesces commits in the same tick and small bursts; sub-perceptible
 * latency on the `"settled"` signal.
 */
export const DEFAULT_SETTLE_DEBOUNCE_MS = 10;

// Re-export the autoclose config surface so operators can
// `import { DEFAULT_AUTOCLOSE_CYCLE_MINUTES, resolveAutocloseConfig }
// from "@rotorsoft/act"`. The implementation lives in
// `internal/config.ts` (the single home for builder-facing config bags)
// to keep this orchestrator file focused on the `Act` class.
export {
  type AutocloseConfig,
  type AutoclosePolicy,
  DEFAULT_AUTOCLOSE_CYCLE_MINUTES,
  DEFAULT_CLOSE_BATCH_SIZE,
  DEFAULT_CLOSE_YIELD_MS,
  resolveAutocloseConfig,
} from "./internal/index.js";

/**
 * Lifecycle events emitted by {@link Act}, mapped to their payload type.
 * Drives the typing of `emit` / `on` / `off` — the event-name argument
 * narrows its payload at the call site.
 *
 * The first parameter is kept (unused) for arity compatibility: `committed`
 * carries snapshots of whichever state each action targeted, so its honest
 * element type is `Snapshot<Schema, TEvents>` — the register map itself was
 * never the shape of any snapshot's state.
 */
export type ActLifecycleEvents<
  _TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
> = {
  committed: Snapshot<Schema, TEvents>[];
  acked: Lease[];
  blocked: BlockedLease[];
  settled: Drain<TEvents>;
  closed: CloseResult;
  /**
   * A **different process** committed an event to the same backing store.
   *
   * Fires only when the configured store implements
   * {@link Store.notify} and there is at least one registered reaction.
   * The orchestrator uses the same signal internally to wake `settle()`
   * — listeners get the raw payload for SSE fan-out, dashboards, and
   * audit logs.
   *
   * Local commits do *not* fire `notified` (use `committed` for those):
   * stores self-filter their own writes so this channel has a clean
   * cross-process semantic.
   */
  notified: StoreNotification;
  /**
   * A stream's sensitive-data payload was wiped via {@link Act.forget}.
   * Fires exactly once per successful `forget(stream)` call — idempotent
   * second calls (no PII left on the stream) return `eventCount: 0` and
   * do NOT re-emit. Apps that never call `forget()` never see this event.
   *
   * Listeners use it for the compliance side of GDPR / CCPA: audit log,
   * downstream cache busts, projection-side wipes that the framework
   * doesn't reach (e.g., search indexes, ETL caches). The framework's own
   * cache is invalidated by `forget()` itself before the event fires.
   */
  forgotten: { stream: string; at: Date; eventCount: number };
  /**
   * A store operation failed during the drain loop (ACT-984). Fires on
   * every failed drain cycle — typically a {@link StoreError} from a
   * degraded backend — carrying the orchestrator circuit breaker's state
   * after the failure (`open` means the drain loop has backed off and will
   * retry after the cooldown). Listen to alert on a degraded store; the
   * framework logs the same error regardless. Emitted only when a listener
   * is registered (Node's `EventEmitter` throws on an unhandled `"error"`).
   */
  error: { error: unknown; circuit: CircuitState };
};

/**
 * Options for {@link Act} construction (passed via {@link ActBuilder.build}).
 *
 * @property maxSubscribedStreams - Cap for the LRU set tracking already-
 *   subscribed reaction streams. Default: {@link DEFAULT_MAX_SUBSCRIBED_STREAMS}.
 * @property settleDebounceMs - Debounce window (ms) used by `settle()` when
 *   the caller doesn't pass `SettleOptions.debounceMs`. Tune this once per
 *   Act instance instead of threading the value through every call site.
 *   Default: {@link DEFAULT_SETTLE_DEBOUNCE_MS}.
 */
export type ActOptions<TLanes extends string = string> = {
  readonly maxSubscribedStreams?: number;
  readonly settleDebounceMs?: number;
  /**
   * Per-Act ports (ACT-501). When set, this Act runs against the
   * provided store + cache instead of the singletons — threaded via
   * AsyncLocalStorage so internals are unchanged. Both are required
   * together (a shared cache across distinct stores would collide on
   * stream keys). Omit for the singleton path.
   */
  readonly scoped?: Scoped;
  /**
   * Correlation-id generator for originating actions (ACT-404). When
   * omitted, Act uses {@link default_correlator}, which produces a
   * readable, time-monotonic-within-window, lowercase id of the form
   * `{state[:4]}-{action[:4]}-{ts}{rnd}` (18 chars).
   *
   * Reactions inherit `reactingTo.meta.correlation` so the chain stays
   * intact — the delegate is only consulted on originating commits and
   * for the close-the-books transaction.
   */
  readonly correlator?: Correlator;
  /** Restrict this process to a subset of declared lanes (ACT-1103). */
  readonly onlyLanes?: ReadonlyArray<TLanes>;
  /**
   * Subscribe to {@link Store.notify} on this instance (#803). Defaults
   * to `true`. Set `false` on instances that only commit and never
   * react — the subscriber-connection budget is the practical scaling
   * ceiling for the notify/listen pattern, and writer-only fleets
   * spend it for nothing when they subscribe to a channel they never
   * read. Commits still emit notifications (that's part of the
   * store's commit protocol); only the subscriber side is gated.
   */
  readonly listen?: boolean;
  /**
   * Run the local reaction pipeline on this instance (#803). Defaults
   * to `true`. Set `false` on writer-only or sidecar instances: drain
   * controllers' auto-cycle workers don't start, `correlate()` /
   * `drain()` / `settle()` become no-ops, and the notify handler
   * skips its drain-wakeup arm (but still emits the `notified`
   * lifecycle event so observability sidecars work).
   */
  readonly drain?: boolean;
  /**
   * Orchestrator circuit breaker for the drain loop (ACT-984). After
   * `failureThreshold` consecutive store failures the breaker opens and
   * the drain loop skips `claim()` for `cooldownMs` instead of hammering a
   * down backend, then allows a half-open trial. Out-of-range values throw
   * a `ZodError` at `act().build()`. Defaults: threshold 5, cooldown 30s.
   */
  readonly circuitBreaker?: CircuitBreakerOptions;
  /**
   * @deprecated Since #1175 this knob is accepted, validated, and
   * ignored. It paced the off-hours re-check of the pre-#1090 autoclose
   * sweep; the synthesized autoclose reaction now derives its re-check
   * directly from `autocloseWindow` — a tick landing outside the window
   * parks until the exact instant the window opens, so there is no
   * polling cadence to configure (and nothing minute-denominated on the
   * close surface). Still validated as an integer `[1, 1440]` so typos
   * keep failing loudly at `act().build()`. Will be removed in the next
   * major.
   */
  readonly autocloseCycleMinutes?: number;
  /**
   * @deprecated Dead since #1090 replaced the autoclose sweep with a
   * synthesized per-aggregate reaction — nothing pages the store in
   * batches anymore, so nothing reads this. Accepted and validated
   * (`[1, 1024]`) for compatibility; will be removed in the next major.
   */
  readonly closeBatchSize?: number;
  /**
   * @deprecated Dead since #1090 — the sweep that yielded between
   * successive `Store.truncate` calls no longer exists; closes are
   * staged per stream by the autoclose reaction. Accepted and validated
   * (`[0, 1000]`) for compatibility; will be removed in the next major.
   */
  readonly closeYieldMs?: number;
  /**
   * @deprecated Dead since #1090 — the sweep-side predicate try/catch
   * this flag steered no longer exists; a throwing policy predicate now
   * follows the reaction retry path (`blockOnError: false`, three
   * retries). Accepted for compatibility; will be removed in the next
   * major.
   */
  readonly closeOnError?: boolean;
  /**
   * Optional off-hours window restricting when autoclose evaluates. A
   * synthesized autoclose reaction that triggers outside the window
   * defers to the next instant the window opens — derived from the
   * window itself, no polling cadence. Hours are `[0, 23]` integers in
   * `timeZone` (IANA, default `"UTC"`, DST-correct); `start > end` is
   * an overnight window (e.g. `{ start: 22, end: 6 }`). Omit to
   * evaluate regardless of clock time.
   */
  readonly autocloseWindow?: {
    readonly start: number;
    readonly end: number;
    readonly timeZone?: string;
  };
  /**
   * Validate folded state against its declared Zod schema after every
   * reduction (ACT-1238). Off by default.
   *
   * When `true`, each time an event is folded into state — on the
   * command path (`do`), on `load`/replay, and inside projection-fold
   * projections — the merged full state is parsed against the owning
   * state's `state({ Name: schema })` schema. A reducer that produces
   * schema-violating state (the calculator divide-by-zero NaN class,
   * #1230) throws a {@link ValidationError} at the triggering event,
   * whose `target` names the state and the event (`<state>.<event>#<id>`)
   * — instead of the bad value propagating and surfacing hops later as a
   * confusing downstream error.
   *
   * This is a **debugging / CI aid, not a production guard**. Turn it on
   * in development and CI to catch total-reducer bugs at the source; the
   * framework already validates action inputs and emitted events, so the
   * reduced state is the one shape it otherwise trusts. The per-event
   * patch step is selected **once at `build()`** (the same way the
   * orchestrator picks bare vs trace-decorated store ops from the log
   * level): when `false` (the default) the fold loop is byte-identical to
   * a bare reduction — the validating patch step is never selected, so
   * there is no per-event cost, not even a branch.
   */
  readonly validateFoldedState?: boolean;
};

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

export class Act<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  TStateMap extends Record<string, Schema> = Record<string, never>,
  TActor extends Actor = Actor,
> implements IAct<TEvents, TActions, TActor, TSchemaReg>
{
  private _emitter = new EventEmitter();
  /** ACT-984: orchestrator-owned circuit breaker shared by all drain lanes. */
  private readonly _breaker: CircuitBreaker;
  /** #803: gate the `Store.notify` subscription side. */
  private readonly _listen: boolean;
  /** #803: gate the local reaction pipeline (drain controllers, settle, correlate). */
  private readonly _drain: boolean;
  /** Event names with at least one registered reaction (computed at build time) */
  private readonly _reactive_events: ReadonlySet<string>;
  /** One DrainController per active lane, keyed by lane name. */
  private readonly _drain_controllers: Map<
    string,
    DrainController<TEvents, TActions, TSchemaReg>
  >;
  /** Correlation state machine: lazy init, dynamic-resolver scan, periodic worker. */
  private readonly _correlate: CorrelateCycle<TSchemaReg, TEvents, TActions>;
  /** Debounced correlate→drain catch-up loop. */
  private readonly _settle: SettleLoop<TEvents>;
  /**
   * Disposer for the cross-process notify subscription, set up eagerly
   * during construction. Held as a promise because the subscription
   * itself may be async (the PG adapter checks out a dedicated client
   * and runs `LISTEN` before resolving). Resolves to `undefined` when
   * the store doesn't implement `notify` or there are no registered
   * reactions.
   *
   * **Contract:** the configured store must be injected via
   * {@link store}`(adapter)` *before* calling `act()...build()`. The
   * orchestrator wires notify against whatever store is current at
   * construction time — late injection after build is unsupported.
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
  /** Map of state name → state definition; populated by the builder. */
  private readonly _states: Map<string, State<any, any, any>>;
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
   * The single store-failure handler: log it, then emit the `error`
   * lifecycle event. Wired into the circuit breaker's `on_error`, so it
   * runs on every `failed()` — drain / settle / autoclose just call
   * `breaker.failed(now, error)` and never log or emit themselves.
   *
   * The emit is guarded against Node's `EventEmitter` contract that an
   * unhandled `"error"` emission is rethrown (which would crash the process
   * from inside the drain catch); logging is unconditional so failures are
   * never silent.
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
  private readonly _event_to_state: ReadonlyMap<string, State<any, any, any>>;
  /**
   * Event-name → lane fan-in for selective arming (ACT-1103). Built by
   * `classify_registry` once per build. `"all"` means at least one of
   * the event's reactions is a dynamic resolver (lane opaque until
   * runtime); a `Set<string>` lists the static lanes only that event's
   * reactions target.
   */
  private readonly _event_to_lanes: ReadonlyMap<string, EventLaneSet>;
  /**
   * Audit dependency bag (#723). Built once at construction; held as
   * an immutable snapshot of the registry state the audit module
   * needs. Lives in `internal/audit.ts` — this orchestrator never
   * carries audit logic, only the deps + a one-liner that hands them
   * over.
   */
  private readonly _audit_deps: AuditDeps;
  /** Logger resolved at construction time (after user port configuration) */
  private readonly _logger: Logger = log();
  /** Wraps a public-method body so internal `store()`/`cache()` resolve to the
   * per-Act ports (ACT-501). No-op when the Act is unscoped — so the singleton
   * path keeps reading fresh `store()`/`cache()` per call, which matters for
   * tests that dispose and re-seed mid-suite. */
  private readonly _scoped: <T>(fn: () => Promise<T>) => Promise<T>;

  /**
   * Correlation-id generator for originating actions. Bound at
   * construction from `options.correlator ?? default_correlator`. The
   * `do()` path passes this into the `_es.action` closure; close-cycle
   * uses it via {@link close_correlation}.
   */
  private readonly _correlator: Correlator;
  /** Pre-bound IAct methods reused across drain cycles. Only `do` varies per
   * payload (it captures the triggering event for reactingTo auto-inject). */
  private readonly _bound_do = this.do.bind(this);
  private readonly _bound_load = this.load.bind(this);
  private readonly _bound_query = this.query.bind(this);
  private readonly _bound_query_array = this.query_array.bind(this);
  private readonly _bound_forget = this.forget.bind(this);
  /** Reaction dispatchers built once and handed to run_drain_cycle each cycle. */
  private readonly _handle: Handle<TEvents>;
  private readonly _handle_batch: HandleBatch<TEvents>;
  /** Declared drain lanes (ACT-1103). */
  private readonly _lanes: ReadonlyArray<LaneConfig>;

  /**
   * Per-stream close serialization tails (#1222). Chains each stream's
   * windowed-close work behind the previous one so a manual
   * `app.close([{stream, before}])` and an autoclose windowed close for
   * the same stream never run their guard-free prune concurrently — the
   * manual path bypasses the `__autoclose__:X` drain lease that would
   * otherwise exclude them, so without this both closers archive the
   * same prefix. Process-local: both racers run on the same Act
   * instance. Entries are dropped once their tail resolves so the map
   * doesn't grow with distinct stream names.
   */
  private readonly _close_locks = new Map<string, Promise<unknown>>();

  /**
   * Run `work` under the per-stream close lock (#1222). Serializes
   * windowed-close critical sections for the same stream while letting
   * different streams proceed in parallel.
   */
  private _with_close_lock<T>(
    stream: string,
    work: () => Promise<T>
  ): Promise<T> {
    const prev = this._close_locks.get(stream) ?? Promise.resolve();
    // Chain after the previous holder regardless of how it settled — a
    // failed close must not wedge the stream's lock forever. The next
    // waiter chains off `next` (the work), so its start is gated on this
    // work completing.
    const next = prev.then(work, work);
    this._close_locks.set(stream, next);
    // Drop the tail once it settles, but only if it's still the current
    // one — a later waiter that already replaced it owns the entry now.
    const cleanup = () => {
      if (this._close_locks.get(stream) === next)
        this._close_locks.delete(stream);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  /** Drain lanes declared via `.withLane(...)`. Implicit default not included. */
  get lanes(): ReadonlyArray<LaneConfig> {
    return this._lanes;
  }

  /**
   * Create a new Act orchestrator. Prefer the {@link act} builder over
   * direct construction — `act()...build()` wires the registry, merges
   * partial states, and collects batch handlers from registered slices
   * and projections in one pass.
   *
   * @param registry  Schemas for every event and action across registered states
   * @param states    Merged map of state name → state definition
   * @param batch_handlers Static-target projection batch handlers (target → handler)
   * @param options   Tuning knobs — see {@link ActOptions}
   * @param lanes     Declared drain lanes (ACT-1103). The builder collects
   *   these from `.withLane(...)` calls. Slice 1 records them on the
   *   instance; later slices fan out one `DrainController` per lane.
   * @param patch_fn  The per-event patch step selected once by the builder
   *   from `ActOptions.validateFoldedState` (ACT-1238) — `bare_patch` by
   *   default, `validating_patch` when the flag is on. The builder uses
   *   the same value for its projection-fold handlers, so there is a
   *   single selection site. Defaults to `bare_patch` for direct
   *   construction.
   */
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
    validate_only_lanes(options, lanes);
    this._scoped = options.scoped
      ? (fn) => scoped.run(options.scoped!, fn)
      : (fn) => fn();
    this._correlator = options.correlator ?? default_correlator;
    this._es = build_es(this._logger, this._correlator, patch_fn);
    this._cd = build_drain<TEvents>(this._logger);
    // Reaction-level PII wrapping happens at build time inside `act-builder`:
    // reactions registered against an event with `sensitive(...)` fields get
    // a stripping handler closure; reactions against non-PII events keep
    // their original handler reference. So the dispatcher is PII-unaware.
    this._handle = build_handle<TEvents, TActions, TActor>({
      logger: this._logger,
      bound_do: this._bound_do,
      bound_load: this._bound_load,
      bound_query: this._bound_query,
      bound_query_array: this._bound_query_array,
      bound_forget: this._bound_forget,
    });
    this._handle_batch = build_handle_batch<TEvents>(this._logger);

    // The registry arrives complete and frozen from the builder — the
    // autoclose reactions were synthesized there, so classification sees
    // the finished shape and nothing here mutates it.
    const classification = classify_registry(this.registry, this._states);
    this._reactive_events = classification.reactive_events;
    this._event_to_state = classification.event_to_state;
    this._event_to_lanes = classification.event_to_lanes;
    this._listen = options.listen !== false;
    this._drain = options.drain !== false;

    // Composition sequence — each step builds one runtime subsystem from
    // the pieces above. Order matters: controllers read the breaker, the
    // audit bag reads the finalized controller set, settle reads the
    // correlate cycle.
    this._breaker = this._build_breaker(options);
    this._drain_controllers = this._build_drain_controllers(options, lanes);
    this._advise_orphaned_lanes(options, lanes);
    this._audit_deps = this._build_audit_deps();
    this._correlate = this._build_correlate(options, classification);
    this._settle = this._build_settle(options);

    // Auto-wire cross-process notify when the store supports it. Bound at
    // construction time — late `store(adapter)` injection after build won't
    // take effect. Scoped Acts bind against their own store.
    this._notify_disposer = this._wire_notify(options.scoped?.store ?? store());

    dispose(() => this.shutdown());
  }

  /**
   * Circuit breaker shared by every store-polling loop (drain, the settle
   * correlate, autoclose). Validates the knobs eagerly so out-of-range
   * values throw at build time, not on the first cycle tick.
   */
  private _build_breaker(options: ActOptions): CircuitBreaker {
    return new CircuitBreaker(
      resolveCircuitBreakerConfig(options.circuitBreaker),
      {
        on_error: (error, circuit) => this._emit_error(error, circuit),
        // Re-probe the store when the cooldown elapses, so recovery is
        // automatic even on the default lane (which has no periodic poller).
        // Any polling loop can trip the shared breaker — but a bare `drain()`
        // only touches the store when the controller is armed, so a trip
        // from a correlate failure could go unprobed. `settle()` always runs
        // a correlate (a store query) before draining, so it re-probes
        // regardless of which loop opened the breaker: one success closes it
        // and every loop resumes on its own cadence. A failed probe re-opens
        // the breaker and reschedules the wake.
        on_retry: () => {
          this.settle({ debounceMs: 0 });
        },
      }
    );
  }

  /**
   * One DrainController per active lane. The implicit "default" lane is
   * always present unless onlyLanes excludes it. Each controller filters
   * its claim() by its lane name; the legacy single-controller path is the
   * active set === { "default" } case with `lane: undefined` deps so
   * claim() doesn't filter (preserves the single-lane SQL planner shape
   * for apps that never call withLane).
   */
  private _build_drain_controllers(
    options: ActOptions,
    lanes: ReadonlyArray<LaneConfig>
  ): Map<string, DrainController<TEvents, TActions, TSchemaReg>> {
    const all_lanes = ["default", ...lanes.map((l) => l.name)];
    const only_set =
      options.onlyLanes && options.onlyLanes.length > 0
        ? new Set<string>(options.onlyLanes as readonly string[])
        : undefined;
    const active_lanes = only_set
      ? all_lanes.filter((n) => only_set.has(n))
      : all_lanes;
    const single_default_lane =
      active_lanes.length === 1 && active_lanes[0] === "default";
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
        handle: this._handle,
        handle_batch: this._handle_batch,
        on_acked: (acked) => this.emit("acked", acked),
        on_blocked: (blocked) => this.emit("blocked", blocked),
        // Reaction-requested close. Runs the same close machinery as
        // `app.close` (tombstone guard + archive + atomic truncate) for the
        // targets a handler signalled via `CloseSignal`. No `correlate()`
        // here — the drain that produced these targets has already
        // correlated.
        on_close: async (targets) => {
          const close_actor = { id: "$close", name: "close" };
          const result = await run_close_cycle(targets, {
            reactive_events_size: this._reactive_events.size,
            event_to_state: this._event_to_state,
            load: this._es.load,
            tombstone: this._es.tombstone,
            logger: this._logger,
            correlation: close_correlation(this._correlator, close_actor),
            with_stream_lock: (stream, work) =>
              this._with_close_lock(stream, work),
          });
          this.emit("closed", result);
        },
        breaker: this._breaker,
        // Re-scope the per-lane worker's auto-start ticks so their drain
        // resolves the scoped ports, not the singleton (#1191).
        run_scoped: this._scoped,
        // Pass lane only when a true per-lane controller is active.
        // The all-lanes (single default) case keeps lane=undefined so
        // adapter SQL collapses to the single-lane shape.
        lane: single_default_lane ? undefined : name,
        defaults: cfg && {
          streamLimit: cfg.streamLimit,
          leaseMillis: cfg.leaseMillis,
        },
      });
      // Auto-start a per-lane worker when the operator declared a
      // cycleMs — the intent of `withLane({cycleMs: 100})` is "drive
      // this lane every 100 ms," independent of the Act-level settle
      // loop. unref()'d so the timer doesn't keep the process alive.
      // Writer-only instances (`drain: false`) construct the controller
      // but never run reactions locally, so the auto-start is skipped.
      if (cfg?.cycleMs !== undefined && options.drain !== false)
        controller.start(cfg.cycleMs);
      controllers.set(name, controller);
    }
    return controllers;
  }

  /**
   * Orphaned-lane startup advisory (#1220). When `onlyLanes` is set, this
   * instance builds a controller only for its slice of the declared lane
   * universe — every OTHER declared lane's stream is persisted (correlate
   * subscribes all static targets regardless of `onlyLanes`) but never
   * claimed here. If no peer worker deploys with those lanes in ITS
   * `onlyLanes`, their reactions accumulate forever, silently. A single
   * process can't verify the cluster invariant `∪ onlyLanes ⊇ declared
   * lanes`, so we surface the per-instance signal — "these declared lanes
   * have no controller here" — the same way the deprecated-event advisory
   * surfaces legacy events. No advisory when `onlyLanes` is unset (every
   * lane gets a controller) or covers every declared lane.
   */
  private _advise_orphaned_lanes(
    options: ActOptions,
    lanes: ReadonlyArray<LaneConfig>
  ): void {
    if (!options.onlyLanes || options.onlyLanes.length === 0) return;
    const active = new Set(this._drain_controllers.keys());
    const orphaned = ["default", ...lanes.map((l) => l.name)].filter(
      (name) => !active.has(name)
    );
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

  /**
   * Audit deps bag. Snapshotted after registry classification and
   * drain-controller build so the audit module sees the finalized lane
   * set. Held as an immutable bag — the orchestrator never carries audit
   * logic itself, only this typed contract.
   */
  private _build_audit_deps(): AuditDeps {
    return {
      store,
      logger: this._logger,
      event_to_state: this._event_to_state,
      states: this._states,
      known_events: new Set(this._event_to_state.keys()),
      // The DECLARED lane universe — the implicit "default" plus every
      // `.withLane(...)` name — NOT `_drain_controllers.keys()` (#1224).
      // An `onlyLanes`-filtered instance builds a controller only for its
      // slice of lanes, so keying off the active controller set would flag
      // a stream correctly assigned to an excluded-but-declared lane (one
      // another worker drains) as `unknown-lane`. The audit reports what's
      // structurally routable across the cluster, not what this process runs.
      declared_lanes: new Set(["default", ...this._lanes.map((l) => l.name)]),
      routed_events: new Set(this._event_to_lanes.keys()),
    };
  }

  /**
   * Correlate cycle over the classified registry. The cold-start callback
   * arms every controller — historical events may need processing —
   * except on writer-only instances (`drain: false`).
   */
  private _build_correlate(
    options: ActOptions,
    classification: ReturnType<
      typeof classify_registry<TSchemaReg, TEvents, TActions>
    >
  ): CorrelateCycle<TSchemaReg, TEvents, TActions> {
    return new CorrelateCycle({
      registry: this.registry,
      static_targets: classification.static_targets,
      has_dynamic_resolvers: classification.has_dynamic_resolvers,
      cd: this._cd,
      max_subscribed_streams:
        options.maxSubscribedStreams ?? DEFAULT_MAX_SUBSCRIBED_STREAMS,
      on_init: () => {
        if (this._drain && this._reactive_events.size > 0) this._arm_all();
      },
      // Re-scope the background `start_correlations` timer so its
      // correlate resolves the scoped ports, not the singleton (#1191).
      run_scoped: this._scoped,
      // Cold-start defer re-seed (#1221). Skipped on writer-only instances
      // (`drain: false`) — they run no local controllers to re-arm.
      on_init_async: this._drain
        ? () => this._seed_persisted_defers()
        : undefined,
    });
  }

  /**
   * Re-seed every active lane controller's process-local defer timer from
   * the store's persisted `deferred_at` (#1221). Runs once at cold start,
   * inside `CorrelateCycle.init`, after static targets are subscribed.
   *
   * The defer timer is worker memory: empty after a restart. A stream
   * deferred to a future due-time (the classic case: an idle autoclose
   * aggregate that deferred its terminal close) is durable in the store but
   * has nothing in memory to re-arm the drain — the controller disarms on
   * the first empty claim and, since the aggregate is idle, no commit ever
   * re-arms it. Reading the persisted schedule and seeding the owning lane's
   * timer restores the wake, so the close fires at the due-time.
   *
   * Streams whose lane has no controller on this instance (excluded by
   * `onlyLanes`) are skipped — a peer worker owns that lane's timer.
   */
  private async _seed_persisted_defers(): Promise<void> {
    const now = Date.now();
    await store().query_streams((pos) => {
      // Only future defers matter — a past-due schedule is claimable
      // already, so the ordinary armed drain picks it up.
      if (pos.deferred_at === undefined || pos.deferred_at <= now) return;
      // Route to the controller that owns the stream's lane. A missing
      // controller means the lane is excluded on this instance (onlyLanes) —
      // skip it, a peer worker owns that timer. The default lane's
      // controller is keyed "default" and matches an undefined stored lane.
      const controller = this._drain_controllers.get(pos.lane ?? "default");
      controller?.seed_defer(pos.stream, pos.deferred_at);
    });
  }

  /** Settle loop driving correlate + drain to quiescence. */
  private _build_settle(options: ActOptions): SettleLoop<TEvents> {
    return new SettleLoop<TEvents>(
      {
        // Scope the init like every other store-touching path — a bare
        // `this._correlate.init()` runs `store().subscribe(...)` against
        // the singleton for a scoped Act, so static targets never land on
        // the scoped store and `_initialized` then blocks a retry (#1191).
        init: () => this._scoped(() => this._correlate.init()),
        checkpoint: () => this._correlate.checkpoint,
        correlate: (q) => this.correlate(q),
        drain: (o) => this.drain(o),
        on_settled: (drain) => this.emit("settled", drain),
        breaker: this._breaker,
      },
      options.settleDebounceMs ?? DEFAULT_SETTLE_DEBOUNCE_MS
    );
  }

  /** True after the first `shutdown()` call. Guards idempotency. */
  private _shutdown_promise: Promise<void> | undefined;

  /**
   * Per-instance teardown: remove lifecycle listeners, stop the
   * correlation worker, cancel any pending settle cycle, and tear
   * down the cross-process notify subscription.
   *
   * Idempotent — repeated calls return the same promise. Registered
   * automatically with the global `dispose()` registry at construction,
   * so process-wide `dispose()()` covers it; test helpers (or operators
   * that mint short-lived Acts) call it explicitly for prompt cleanup.
   */
  shutdown(): Promise<void> {
    if (!this._shutdown_promise) {
      this._shutdown_promise = (async () => {
        this._emitter.removeAllListeners();
        this.stop_correlations();
        this.stop_settling();
        this._breaker.stop();
        for (const c of this._drain_controllers.values()) c.stop();
        // `_wire_notify` swallows subscription errors and resolves to
        // `undefined`, so this promise never rejects.
        const disposer = await this._notify_disposer;
        if (disposer) await disposer();
      })();
    }
    return this._shutdown_promise;
  }

  /**
   * Subscribe to {@link Store.notify} when both the store and the
   * registry support it. Returns the disposer (or `undefined` when no
   * subscription was made). Errors during subscription are logged but
   * never thrown — `notify` is a hint, not a contract.
   */
  private async _wire_notify(
    s: Store
  ): Promise<(() => void | Promise<void>) | undefined> {
    if (this._reactive_events.size === 0) return undefined;
    if (!s.notify) return undefined;
    // #803: writer-only / single-instance deployments opt out of the
    // subscriber-connection cost. Commits still notify (that's the
    // store's commit protocol); only the subscriber side is gated.
    if (!this._listen) return undefined;
    try {
      return await s.notify((notification) => {
        // Generic concerns (lifecycle emit, drain wakeup, listener
        // error containment) live here so adapters only have to
        // handle their own wire format. Errors in user-registered
        // `notified` listeners or in our own bookkeeping are logged
        // and swallowed — the store's listener stays alive.
        try {
          this.emit("notified", notification);
          // Wake once per commit when at least one event has a local
          // reaction. Avoids spurious wake-ups for remote commits
          // belonging to bounded contexts this process doesn't react to.
          // ACT-1103: selective arming via the shared helper — only the
          // lanes whose reactions match the notified events.
          // #803: the sidecar pattern (listen: true, drain: false)
          // wants the `notified` lifecycle event for observability
          // without engaging the local reaction pipeline.
          if (this._drain) {
            const armed = this._arm_for_event_names(
              notification.events.map((e) => e.name)
            );
            if (armed) this._settle.schedule({ debounceMs: 0 });
          }
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
   *       // await app.do("reduceStock", target, payload, { reactingTo: customEvent });
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
    options?: DoOptions<TEvents>
  ) {
    return this._scoped(async () => {
      const snapshots = await this._es.action(
        this.registry.actions[action],
        action,
        target,
        payload,
        options
      );
      // Arm the drain when any committed event has reactions (ACT-1103:
      // arm only the lanes whose reactions match — events whose reactions
      // are all statically lane-resolved arm a subset; events with at
      // least one dynamic resolver fall back to _arm_all via the "all"
      // sentinel).
      if (this._reactive_events.size > 0)
        // Snapshots produced by `action()` always carry their committed
        // event — the optional `event?` on the type is for load()
        // snapshots, which don't reach this path.
        this._arm_for_event_names(
          snapshots.map((s) => (s.event as { name: string }).name)
        );
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
   * @param query - Filter criteria — see {@link Query} for available fields
   *   (`stream`, `name`, `after`, `before`, `created_after`, `created_before`,
   *   `limit`, `with_snaps`, `stream_exact`)
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
    return this._scoped(async () => {
      let first: Committed<TEvents, keyof TEvents> | undefined;
      let last: Committed<TEvents, keyof TEvents> | undefined;
      const count = await store().query<TEvents>((e) => {
        if (!first) first = e;
        last = e;
        callback?.(e);
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
    return this._scoped(async () => {
      const events: Committed<TEvents, keyof TEvents>[] = [];
      await store().query<TEvents>((e) => events.push(e), query);
      return events;
    });
  }

  /**
   * Wipe the sensitive-data payload for every event on the stream — see
   * {@link IAct.forget}. Application-level half of #566.
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
   * @param options - Drain configuration — see {@link DrainOptions} for fields
   *   (`streamLimit`, `eventLimit`, `leaseMillis`).
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
  async drain(options: DrainOptions = {}): Promise<Drain<TEvents>> {
    // Validate the runtime knobs before anything runs (a bad leaseMillis /
    // streamLimit / eventLimit throws ZodError here, not on the first cycle).
    resolveDrainConfig(options);
    // #803: writer-only instances skip the local reaction pipeline.
    // Return an empty Drain result so call sites that aggregate (e.g.,
    // `settle` listeners) keep working without special-casing.
    if (!this._drain)
      return { fetched: [], leased: [], acked: [], blocked: [] };
    return this._scoped(() => this._drain_all(options));
  }

  /** Arm every active lane controller (ACT-1103). */
  private _arm_all(): void {
    for (const c of this._drain_controllers.values()) c.arm();
  }

  /**
   * Arm only the lane controllers whose reactions match the supplied
   * event names (ACT-1103 selective arming). Events with any dynamic
   * resolver fall back to `_arm_all()` via the `"all"` sentinel — the
   * resolver's lane isn't known until correlate runs the function.
   * Events with no reactions are skipped; `_event_to_lanes` doesn't
   * carry them. Returns true when any controller was armed (used by
   * the notify handler to decide whether to schedule a settle).
   */
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
    for (const lane of to_arm) this._drain_controllers.get(lane)?.arm();
    return true;
  }

  /** Drain every active lane controller in parallel and aggregate.
   *
   * Parallel — not sequential — so a slow lane's in-flight handler does
   * not block a fast lane's claim/dispatch/ack cycle. Each controller's
   * `claim()` is independent (filtered by lane); the store's
   * `SKIP LOCKED` keeps cross-controller races safe. Lifecycle events
   * (`acked`, `blocked`) may interleave by lane — listeners filter via
   * `lease.lane`. */
  private async _drain_all(options: DrainOptions): Promise<Drain<TEvents>> {
    const results = await Promise.all(
      [...this._drain_controllers.values()].map((c) => c.drain(options))
    );
    const fetched: Drain<TEvents>["fetched"] = [];
    const leased: Lease[] = [];
    const acked: Lease[] = [];
    const blocked: BlockedLease[] = [];
    for (const r of results) {
      fetched.push(...r.fetched);
      leased.push(...r.leased);
      acked.push(...r.acked);
      blocked.push(...r.blocked);
    }
    return { fetched, leased, acked, blocked };
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
   * @param query - Scan filter — see {@link Query} for fields (typically
   *   `{ after: <event-id>, limit: <count> }`)
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
    // Writer-only instances skip dynamic stream discovery. The
    // {subscribed, last_id} pair returns the no-op result; the
    // checkpoint stays where it was.
    if (!this._drain) return { subscribed: 0, last_id: -1 };
    return this._scoped(async () => {
      const result = await this._correlate.correlate(query);
      // Newly-subscribed streams must arm their lane controllers, same
      // as reset/unblock: a lane worker's tick can disarm on an empty
      // claim in the window before the subscription lands, and nothing
      // re-arms until an unrelated commit — starving the fresh stream
      // on an otherwise idle system.
      if (result.subscribed > 0 && this._reactive_events.size > 0)
        this._arm_all();
      return result;
    });
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
   * @param query - Query filter for correlation scans — see {@link Query}
   *   (typically `{ after: -1, limit: 100 }`)
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
    const started = this._correlate.start_polling(query, frequency, callback);
    return started;
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
    this._correlate.stop_polling();
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
   * @param input - Reaction target streams (e.g., projection names) to reset, or a {@link StreamFilter} for bulk operations
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
  async reset(input: string[] | StreamFilter): Promise<number> {
    return this._scoped(async () => {
      const count = await store().reset(input);
      if (count > 0 && this._reactive_events.size > 0) this._arm_all();
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
   * Wraps `store().unblock(streams)` and raises the orchestrator's
   * internal "needs drain" flag so a settled app picks up the now-free
   * streams on the next cycle. Equivalent to calling `store().unblock(...)`
   * directly, but `store().unblock(...)` alone leaves the flag
   * untouched.
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
      if (count > 0 && this._reactive_events.size > 0) this._arm_all();
      return count;
    });
  }

  /**
   * Atomically wipe the store and rebuild it from an async stream of
   * committed events. The framework owns iteration, validation,
   * `drop_snapshots` filtering, `on_progress`, and the per-call
   * `old → new` causation remap; the adapter's {@link Store.restore}
   * driver supplies the transaction lifecycle and per-event insert.
   *
   * Throws if the adapter has no restore capability. Throws on the
   * first invalid event (negative version, malformed `created`) with
   * the running index in the message; atomic transaction rollback in
   * the adapter means a failing restore leaves the store byte-for-byte
   * unchanged.
   *
   * @param source - Async stream of events in target order. Streamed
   *   rather than buffered so multi-million-event backups don't OOM.
   *   Each event's original `id` is used as a causation lookup key but
   *   never written through — adapters renumber densely.
   * @param opts - {@link ScanOptions}. `drop_snapshots` skips
   *   `__snapshot__` events (counted in the result); `on_progress`
   *   fires once per event.
   * @returns {@link ScanResult} with `kept`, `duration_ms`, and
   *   `dropped` per-category counters.
   *
   * @example Round-trip a CSV backup
   * ```typescript
   * async function* parseCsv(blob: string) {
   *   for (const line of blob.split("\n").slice(1)) {
   *     const [id, name, data, stream, version, created, meta] = parse(line);
   *     yield {
   *       id: +id, name, data: JSON.parse(data), stream,
   *       version: +version, created: new Date(created),
   *       meta: JSON.parse(meta),
   *     };
   *   }
   * }
   * const result = await app.restore(parseCsv(csvBlob), {});
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
      // Dry-run: walk the source via scan without touching any sink
      // — same scan loop, no callback, no transaction, no capability
      // check. Returns the counts a destructive restore would land.
      if (opts.dry_run) {
        const partial = await scan(source, opts);
        return { ...partial, duration_ms: Date.now() - started };
      }
      // Default sink is the singleton store. Explicit `sink` lets
      // callers route to a different EventSink (another adapter, a
      // CsvFile, etc.) without binding the singleton.
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
   * Operator-driven store audit (#723).
   *
   * Walks the connected store and yields per-category findings —
   * each tagged with the remediation it suggests. Same operator-
   * driven category as `app.close()` / `app.reset()` /
   * `app.unblock()` / `app.blocked_streams()`: never auto-invoked by
   * the framework; the operator decides when to run it (CI gate,
   * scheduled job, ad-hoc forensics) and what to do with the
   * findings.
   *
   * Categories are independent — pass a subset to scope the work,
   * or omit to run everything:
   *
   * ```typescript
   * // Targeted: schema drift + deprecated-event load only
   * for await (const f of app.audit(["schema", "deprecated-load"], {
   *   query: { created_after: lastScan },
   *   thresholds: { deprecatedLoadShareMin: 0.10 },
   * })) {
   *   await escalate(f);
   * }
   *
   * // Full audit, default thresholds
   * for await (const f of app.audit()) console.log(f);
   * ```
   *
   * Returns an `AsyncIterable` so callers can `break` early — the
   * underlying store paginations respect the iterator protocol and
   * stop cleanly. Each finding is emitted independently, so
   * pipelining into Slack / persistence / further analysis works
   * without buffering the full report in memory.
   *
   * Findings shape — see {@link AuditFinding}. The discriminated
   * union carries enough context for the operator to act on each
   * finding directly: stream id, event id, recommendation hints.
   *
   * @param categories - Subset of categories to run (default: all).
   * @param options - Query window + per-category thresholds.
   * @returns Async iterable of {@link AuditFinding}.
   */
  audit(
    categories?: AuditCategory[],
    options?: AuditOptions
  ): AsyncIterable<AuditFinding> {
    return audit(this._audit_deps, categories, options);
  }

  /**
   * Bulk-update scheduling priority for streams matching `filter`.
   *
   * Operator-grade override of the `claim()` lagging-frontier
   * ordering (ACT-102). Useful when a long-running replay needs to
   * jump ahead of other lagging streams, or when a no-longer-urgent
   * job should yield slots back to the rest. Build-time priorities
   * (set via the resolver's `priority` field) are subject to a
   * `max()` invariant across reactions; this API ignores that and
   * sets the priority outright on every matching row.
   *
   * Filter shape mirrors {@link query} / {@link Store.query_streams}:
   * `stream` / `source` are regex by default, exact with the
   * `*_exact` flags; `blocked` restricts to blocked or unblocked
   * rows. **An empty filter (`{}`) updates every registered stream.**
   *
   * @param filter - Selection criteria (regex by default).
   * @param priority - New priority value. Set as-is — no clamp.
   * @returns Count of streams whose priority changed.
   *
   * @example Boost a specific projection mid-replay
   * ```typescript
   * await app.prioritize({ stream: "^proj-orders$", stream_exact: false }, 10);
   * ```
   *
   * @example Drop all audit projections to background
   * ```typescript
   * await app.prioritize({ source: "^audit-" }, -5);
   * ```
   *
   * @example Reset everyone to default
   * ```typescript
   * await app.prioritize({}, 0);
   * ```
   *
   * @see {@link Store.prioritize} for the underlying primitive
   * @see {@link claim} for how priority biases scheduling
   */
  async prioritize(filter: StreamFilter, priority: number): Promise<number> {
    return this._scoped(() => store().prioritize(filter, priority));
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
   * Targets carrying `before` take the **windowed** branch instead —
   * close the books on a rolling window: probe the min consumer
   * watermark (so the boundary never rises past a lagging reaction),
   * run the archive callback against the cutoff, then prune the prefix
   * below the closest safe `__snapshot__`. No tombstone guard (the
   * pre-cutoff prefix is immutable), no seed, cache untouched — the
   * stream stays live and keeps accepting actions. Requires the state
   * to snapshot via `.snap(...)`; no qualifying snapshot ⇒ the stream
   * lands in `skipped` (retry after the next snapshot). Windowed
   * entries in the result echo `before` and carry the surviving
   * boundary snapshot as `committed`.
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
   *
   * @example Close with restart (state loaded automatically after guard)
   * ```typescript
   * await app.close([
   *   { stream: "counter-1", restart: true },
   *   { stream: "counter-2" },  // tombstoned
   * ]);
   * ```
   *
   * @example Windowed close — keep the last 180 days of real events
   * ```typescript
   * const cutoff = new Date();
   * cutoff.setDate(cutoff.getDate() - 180);
   * await app.close([
   *   {
   *     stream: "ledger-acme",
   *     before: cutoff,
   *     archive: async () => { await archiveToS3("ledger-acme", cutoff); },
   *   },
   * ]);
   * ```
   */
  async close(targets: CloseTarget[]): Promise<CloseResult> {
    if (!targets.length) return { truncated: new Map(), skipped: [] };

    return this._scoped(async () => {
      // Correlate first so dynamic reaction targets are discovered before
      // the safety check examines subscription positions.
      await this.correlate({ limit: 1000 });

      // Synthesize an actor for the close transaction so user-supplied
      // correlators can still tag tenant context / trace ids.
      const close_actor = { id: "$close", name: "close" };
      const result = await run_close_cycle(targets, {
        reactive_events_size: this._reactive_events.size,
        event_to_state: this._event_to_state,
        load: this._es.load,
        tombstone: this._es.tombstone,
        logger: this._logger,
        correlation: close_correlation(this._correlator, close_actor),
        with_stream_lock: (stream, work) => this._with_close_lock(stream, work),
      });

      this.emit("closed", result);
      return result;
    });
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
   * @param options - Settle configuration — see {@link SettleOptions} for fields:
   *   `debounceMs` (default 10), `correlate` (default `{ after: -1, limit: 100 }`),
   *   `maxPasses` (default `Infinity` — kill-switch for runaway loops),
   *   `streamLimit` (default 10), `eventLimit` (default 10),
   *   `leaseMillis` (default 10000).
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
    // Validate the runtime knobs before anything runs (a bad debounceMs /
    // leaseMillis / maxPasses throws ZodError here, not on the first pass).
    resolveSettleConfig(options);
    // #803: writer-only instances skip settle entirely. The bootstrap
    // pattern `app.on("committed", () => app.settle())` keeps working —
    // it just runs zero work on writers.
    if (!this._drain) return;
    this._settle.schedule(options);
  }
}
