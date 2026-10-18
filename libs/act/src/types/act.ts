/**
 * Public contracts of the orchestrator: the options `act().build()` takes,
 * the lifecycle events an `Act` emits, and the public defaults behind them.
 * The `Act` class implements them in `../act.ts`; their Zod schemas and
 * resolvers live in `../internal/config.ts`.
 */
import type {
  CloseResult,
  Correlator,
  Schema,
  Schemas,
  Snapshot,
} from "./action.js";
import type { Cache, Store, StoreNotification } from "./ports.js";
import type { BlockedLease, Drain, Lease } from "./reaction.js";
import type { SchemaRegister } from "./registry.js";

/**
 * Default debounce window (ms) for `settle()` when neither the per-call
 * `SettleOptions.debounceMs` nor `ActOptions.settleDebounceMs` is set.
 * Coalesces commits in the same tick and small bursts.
 */
export const DEFAULT_SETTLE_DEBOUNCE_MS = 10;
/**
 * Default LRU cap for the subscribed-streams cache. Apps that mint many
 * dynamic targets (one per aggregate) should override it with
 * `ActOptions.maxSubscribedStreams`.
 */
export const DEFAULT_MAX_SUBSCRIBED_STREAMS = 1000;

/** Per-Act ports bag. Both required together — a shared cache across stores would collide on stream keys. */
export type Scoped = {
  readonly store: Store;
  readonly cache: Cache;
};

/** Circuit breaker state, reported with every `error` lifecycle event. */
export type CircuitState = "closed" | "open" | "half-open";

/** Public, all-optional circuit-breaker options bag for `act().build()`. */
export type CircuitBreakerOptions = {
  failureThreshold?: number;
  cooldownMs?: number;
};

/** Resolved autoclose configuration after validation + default expansion. */
export type AutocloseConfig = {
  autocloseWindow?: { start: number; end: number; timeZone: string };
};

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
   * A store operation failed during the drain loop. Fires on
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
 * @property maxSubscribedStreams - Cap for the LRU tracking what each
 *   dynamically resolved reaction target was last subscribed at. Statically
 *   declared targets are held outside it and never evicted, so their lane
 *   and priority stay owned by the build-time subscribe.
 *   Default: {@link DEFAULT_MAX_SUBSCRIBED_STREAMS}.
 * @property settleDebounceMs - Debounce window (ms) used by `settle()` when
 *   the caller doesn't pass `SettleOptions.debounceMs`. Tune this once per
 *   Act instance instead of threading the value through every call site.
 *   Default: {@link DEFAULT_SETTLE_DEBOUNCE_MS}.
 * @property autoSettle - Settle on its own after a change that frees
 *   reaction work: a commit, `reset()`, `unblock()`, `restore()` or a
 *   notification from another process. Set `false` when you walk the
 *   pipeline yourself with `correlate()` / `drain()` (tests that check its
 *   steps, tools). Timers still run: lanes with `cycleMs`,
 *   `start_correlations()`, the circuit breaker's recovery pass after a
 *   store failure, and each stream's backoff or defer wake-up.
 *   Default: `true`.
 */
export type ActOptions<TLanes extends string = string> = {
  readonly maxSubscribedStreams?: number;
  readonly settleDebounceMs?: number;
  readonly autoSettle?: boolean;
  /**
   * Per-Act ports. When set, this Act runs against the
   * provided store + cache instead of the singletons — threaded via
   * AsyncLocalStorage so internals are unchanged. Both are required
   * together (a shared cache across distinct stores would collide on
   * stream keys). Omit for the singleton path.
   */
  readonly scoped?: Scoped;
  /**
   * Correlation-id generator for originating actions. When
   * omitted, Act uses {@link default_correlator}, which produces a
   * readable, time-monotonic-within-window, lowercase id of the form
   * `{state[:4]}-{action[:4]}-{ts}{rnd}` (18 chars).
   *
   * Reactions inherit `reactingTo.meta.correlation` so the chain stays
   * intact — the delegate is only consulted on originating commits and
   * for the close-the-books transaction.
   */
  readonly correlator?: Correlator;
  /** Restrict this process to a subset of declared lanes. */
  readonly onlyLanes?: ReadonlyArray<TLanes>;
  /**
   * Subscribe to {@link Store.notify} on this instance. Defaults
   * to `true`. Set `false` on instances that only commit and never
   * react — the subscriber-connection budget is the practical scaling
   * ceiling for the notify/listen pattern, and writer-only fleets
   * spend it for nothing when they subscribe to a channel they never
   * read. Commits still emit notifications (that's part of the
   * store's commit protocol); only the subscriber side is gated.
   */
  readonly listen?: boolean;
  /**
   * Run the local reaction pipeline on this instance. Defaults
   * to `true`. Set `false` on writer-only or sidecar instances: drain
   * controllers' auto-cycle workers don't start, `correlate()` /
   * `drain()` / `settle()` become no-ops, and the notify handler
   * skips its drain-wakeup arm (but still emits the `notified`
   * lifecycle event so observability sidecars work).
   */
  readonly drain?: boolean;
  /**
   * Orchestrator circuit breaker for the drain loop. After
   * `failureThreshold` consecutive store failures the breaker opens and
   * the drain loop skips `claim()` for `cooldownMs` instead of hammering a
   * down backend, then allows a half-open trial. Out-of-range values throw
   * a `ZodError` at `act().build()`. Defaults: threshold 5, cooldown 30s.
   */
  readonly circuitBreaker?: CircuitBreakerOptions;
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
   * reduction. Off by default.
   *
   * When `true`, each time an event is folded into state — on the
   * command path (`do`), on `load`/replay, and inside projection-fold
   * projections — the merged full state is parsed against the owning
   * state's `state({ Name: schema })` schema. A reducer that produces
   * schema-violating state (the calculator divide-by-zero NaN
   * class) throws a {@link ValidationError} at the triggering event,
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
