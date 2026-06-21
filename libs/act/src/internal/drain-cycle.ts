/**
 * @module drain-cycle
 * @category Internal
 *
 * Two layers of the drain pipeline:
 *
 * - {@link run_drain_cycle} — pure function for one round-trip of
 *   claim → fetch → group → dispatch → ack/block. No orchestrator state.
 *   Reusable for property tests and standalone benchmarks.
 *
 * - {@link DrainController} — stateful driver that owns the armed flag,
 *   the concurrency lock, and the adaptive lag/lead ratio. Wraps
 *   `run_drain_cycle` with the lifecycle decisions Act used to make inline.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";
import type {
  BatchHandler,
  BlockedLease,
  Drain,
  DrainOptions,
  Fetch,
  Lease,
  Logger,
  ReactionPayload,
  Registry,
  SchemaRegister,
  Schemas,
} from "../types/index.js";
import type { CircuitBreaker, CircuitState } from "./circuit-breaker.js";
import type { DrainOps } from "./drain.js";
import { compute_lag_lead_ratio } from "./drain-ratio.js";
import { trace_cycle } from "./tracing.js";

/**
 * Outcome of processing a single leased stream — produced by Act's `handle`
 * / `handle_batch` dispatchers, consumed by `run_drain_cycle` to drive ack/block.
 *
 * @internal
 */
export type HandleResult = Readonly<{
  lease: Lease;
  handled: number;
  /**
   * Event id at which the ack would land — the last *successful* event
   * id, or `lease.at` when the batch had no work (empty payloads). Named
   * `acked_at` to pair symmetrically with {@link failed_at} and to keep
   * it visually distinct from `Lease.at` (the pre-cycle watermark — same
   * field name across types but a different semantic).
   */
  acked_at: number;
  error?: string;
  block?: boolean;
  /**
   * Wall-clock timestamp (ms since epoch) at which the next attempt on
   * this stream may run. Populated by `_finalize` only on retry paths
   * where the reaction defined `options.backoff`. Undefined means "no
   * backoff configured" — drain re-attempts as soon as the lease expires.
   */
  next_attempt_at?: number;
  /**
   * Event id that threw, when a handler error occurred. Distinct from
   * {@link acked_at}: `failed_at = acked_at + 1` in dense streams, but
   * adapters with sparse ids give the trace the exact position. Always
   * set on the per-event error path; absent in batch mode (where no
   * single event id can be attributed to the failure).
   */
  failed_at?: number;
}>;

/**
 * Per-event reaction dispatcher signature (matches `Act.handle`).
 * @internal
 */
export type Handle<TEvents extends Schemas> = (
  lease: Lease,
  payloads: ReactionPayload<TEvents>[]
) => Promise<HandleResult>;

/**
 * Bulk reaction dispatcher signature (matches `Act.handle_batch`).
 * @internal
 */
export type HandleBatch<TEvents extends Schemas> = (
  lease: Lease,
  payloads: ReactionPayload<TEvents>[],
  batchHandler: BatchHandler<TEvents>
) => Promise<HandleResult>;

/**
 * One drain cycle's results. Returned by {@link run_drain_cycle}; consumed by
 * `Act.drain()` to update lifecycle state, the lag/lead ratio, and emit the
 * `acked` / `blocked` lifecycle events.
 *
 * @internal
 */
export type DrainCycle<TEvents extends Schemas> = {
  readonly leased: Lease[];
  readonly fetched: Fetch<TEvents>;
  readonly handled: HandleResult[];
  readonly acked: Lease[];
  readonly blocked: BlockedLease[];
};

/**
 * Run one drain cycle: claim streams, fetch their events, dispatch
 * matching reactions, ack the successes, block the retries-exhausted.
 *
 * Returns `undefined` when nothing was claimed — caller can short-circuit
 * the rest of the drain pass.
 *
 * **Deferred streams.** When `is_deferred(stream)` returns `true`, the
 * cycle skips dispatch for that lease — no handle, no ack, no block. The
 * lease holds for `leaseMillis` via the existing claim mechanism, which
 * blocks competing workers from re-attempting during the backoff window
 * and serves as the per-worker pacing timer. Subsequent claims after
 * `leased_until` expires will re-acquire the lease and re-skip until the
 * controller clears the entry.
 *
 * @internal
 */
export async function run_drain_cycle<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
>(
  ops: DrainOps<TEvents>,
  registry: Registry<TSchemaReg, TEvents, TActions>,
  batch_handlers: Map<string, BatchHandler<TEvents>>,
  handle: Handle<TEvents>,
  handle_batch: HandleBatch<TEvents>,
  lagging: number,
  leading: number,
  eventLimit: number,
  leaseMillis: number,
  is_deferred?: (stream: string) => boolean,
  lane?: string
): Promise<DrainCycle<TEvents> | undefined> {
  // Atomically discover and lease streams (competing consumer pattern)
  const leased = await ops.claim(
    lagging,
    leading,
    randomUUID(),
    leaseMillis,
    lane
  );
  if (!leased.length) return undefined;

  // Partition out streams whose handler is in a backoff window. We hold
  // their leases (no ack/block) so competing workers can't re-attempt
  // during the configured delay.
  const active = is_deferred
    ? leased.filter((l) => !is_deferred(l.stream))
    : leased;
  if (!active.length) {
    return {
      leased,
      fetched: [],
      handled: [],
      acked: [],
      blocked: [],
    };
  }

  // Fetch events for each active leased stream
  const fetched = await ops.fetch(active, eventLimit);

  // Build a single index keyed by stream — collapses two passes
  // (payloads_map build + per-lease fetched.find) into one Map lookup.
  type FetchEntry = (typeof fetched)[number];
  const fetch_map = new Map<
    string,
    { fetch: FetchEntry; payloads: ReactionPayload<TEvents>[] }
  >();

  // compute fetch window max event id
  const fetch_window_at = fetched.reduce(
    (max, { at, events }) => Math.max(max, events.at(-1)?.id || at),
    0
  );

  for (const f of fetched) {
    const { stream, events } = f;
    const payloads = events.flatMap((event) => {
      const register = registry.events[event.name];
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
    fetch_map.set(stream, { fetch: f, payloads });
  }

  const handled = await Promise.all(
    active.map((lease) => {
      // fetch() returns one entry per leased stream — fetch_map.get is
      // always defined here (asserted with `!`).
      const entry = fetch_map.get(lease.stream)!;
      // fast-forward watermark using fetched events or window max
      const at = entry.fetch.events.at(-1)?.id || fetch_window_at;
      const { payloads } = entry;
      const batchHandler = batch_handlers.get(lease.stream);
      if (batchHandler && payloads.length > 0) {
        return handle_batch({ ...lease, at }, payloads, batchHandler);
      }
      return handle({ ...lease, at }, payloads);
    })
  );

  // Ack any result that made progress — full success (no error), empty
  // payloads (no work to do, watermark fast-forwards), and partial
  // success (some events processed before the failure). The `error`
  // string is no longer the "skip ack" signal; `handled > 0 || !error`
  // is. Partial-success-then-block now lands in both `acked` and
  // `blocked` arrays for the same stream — by design.
  const acked = await ops.ack(
    handled
      .filter((h) => h.handled > 0 || !h.error)
      .map((h) => ({ ...h.lease, at: h.acked_at }))
  );

  const blocked = await ops.block(
    handled
      .filter(({ block }) => block)
      .map(({ lease, error }) => ({ ...lease, error: error! }))
  );

  return { leased, fetched, handled, acked, blocked };
}

/**
 * Empty drain result returned when the controller short-circuits (not
 * armed, locked out by a concurrent caller, claim returned nothing,
 * cycle threw).
 *
 * @internal
 */
const EMPTY_DRAIN: Drain<Schemas> = {
  fetched: [],
  leased: [],
  acked: [],
  blocked: [],
};

/**
 * Dependencies the {@link DrainController} needs from the orchestrator.
 * The lifecycle event sinks (`on_acked` / `on_blocked`) are callbacks so
 * this module doesn't reach back into Act's emitter.
 *
 * @internal
 */
export type DrainControllerDeps<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
> = {
  readonly logger: Logger;
  readonly ops: DrainOps<TEvents>;
  readonly registry: Registry<TSchemaReg, TEvents, TActions>;
  readonly batch_handlers: Map<string, BatchHandler<TEvents>>;
  readonly handle: Handle<TEvents>;
  readonly handle_batch: HandleBatch<TEvents>;
  readonly on_acked: (acked: Lease[]) => void;
  readonly on_blocked: (blocked: BlockedLease[]) => void;
  /**
   * Shared, orchestrator-owned circuit breaker (ACT-984). Trips after
   * repeated store failures so the drain loop stops hammering a down
   * backend; closed/half-open let attempts through.
   */
  readonly breaker: CircuitBreaker;
  /**
   * Surface a store/drain failure to the orchestrator (which emits the
   * `error` lifecycle event). Carries the breaker state after the failure.
   */
  readonly on_error: (error: unknown, circuit: CircuitState) => void;
  /** Lane this controller drains. Undefined = spans all lanes (legacy single-controller). */
  readonly lane?: string;
  /** Per-lane defaults applied when caller doesn't override via DrainOptions. */
  readonly defaults?: {
    readonly streamLimit?: number;
    readonly eventLimit?: number;
    readonly leaseMillis?: number;
  };
};

/**
 * Stateful driver around {@link run_drain_cycle}. Owns:
 *
 * - `_armed`  — has any commit / reset / cold-start signaled work to do?
 * - `_locked` — concurrent-call guard (overlapping `drain()` calls return
 *               an empty result instead of running twice)
 * - `_ratio`  — adaptive lag-to-lead frontier split, updated per cycle
 *
 * The orchestrator owns commits, lifecycle emission, and `arm()` triggers
 * — the controller owns everything between those edges.
 *
 * @internal
 */
export class DrainController<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
> {
  private _armed = false;
  private _locked = false;
  private _ratio = 0.5;
  /**
   * Per-stream backoff: `stream → next_attempt_at` (ms since epoch). Set by
   * `_finalize` via `HandleResult.next_attempt_at`; cleared on successful
   * ack or terminal block. Lives in process memory — per-worker pacing
   * by design (see {@link BackoffOptions} for the multi-worker trade-off).
   */
  private _backoff = new Map<string, number>();
  /** Timer re-arming drain at the earliest pending `next_attempt_at`. */
  private _backoff_timer: ReturnType<typeof setTimeout> | undefined;
  /** Worker timer (ACT-1103). Set when `start()` is active, undefined otherwise. */
  private _worker: ReturnType<typeof setTimeout> | undefined;
  private _stopped = false;

  private readonly _deps: DrainControllerDeps<TEvents, TActions, TSchemaReg>;

  constructor(deps: DrainControllerDeps<TEvents, TActions, TSchemaReg>) {
    this._deps = deps;
  }

  /**
   * Signal that a commit (or reset / cold-start) may have produced work.
   * Subsequent `drain()` calls will run the pipeline; once the pipeline
   * settles to no-progress, the controller disarms itself.
   */
  arm(): void {
    this._armed = true;
  }

  /** Read-only flag — true while a commit / reset is unprocessed. */
  get armed(): boolean {
    return this._armed;
  }

  /** Returns true when `stream` is currently within a backoff window. */
  private is_deferred = (stream: string): boolean => {
    const next = this._backoff.get(stream);
    return next !== undefined && next > Date.now();
  };

  /**
   * Schedule the next drain re-arm at the earliest pending backoff
   * expiry. Called only when the backoff map is non-empty (caller guard).
   * Idempotent — collapses many simultaneously deferred streams into a
   * single timer.
   */
  private schedule_backoff_wake(): void {
    if (this._backoff_timer) clearTimeout(this._backoff_timer);
    let earliest = Number.POSITIVE_INFINITY;
    for (const t of this._backoff.values()) if (t < earliest) earliest = t;
    const delay = Math.max(0, earliest - Date.now());
    this._backoff_timer = setTimeout(() => {
      this._backoff_timer = undefined;
      // Garbage-collect expired entries so the next cycle sees ready
      // streams as active. Drain will be re-triggered by whoever owns the
      // settle loop (or by the next commit). Re-arm here so a debounced
      // settle picks it up.
      const now = Date.now();
      for (const [stream, at] of this._backoff) {
        if (at <= now) this._backoff.delete(stream);
      }
      this._armed = true;
    }, delay);
    // Don't keep the event loop alive solely for backoff timers — letting
    // a process exit during retry pacing is the right default. Safe to call
    // unconditionally: Node's `setTimeout` always returns a Timeout with
    // `unref()`.
    this._backoff_timer.unref();
  }

  /** Lane this controller drains (undefined = legacy single-lane span). */
  get lane(): string | undefined {
    return this._deps.lane;
  }

  /**
   * Start a per-lane worker that drains at the lane's `cycleMs`
   * cadence (ACT-1103). When armed, the worker calls `drain()` on every
   * tick and re-schedules; when not armed, it still re-schedules at
   * `cycleMs` so a future `arm()` is picked up on the next tick.
   *
   * The setTimeout chain uses `unref()` so it doesn't keep the process
   * alive on its own.
   */
  start(cycleMs: number): void {
    if (this._worker || this._stopped) return;
    // `drain()` swallows its own errors and returns EMPTY_DRAIN, so the
    // tick is exception-free by contract. The post-drain `_stopped`
    // check prevents re-scheduling after `stop()` was called mid-tick;
    // an already-queued timer that fires before `clearTimeout()` lands
    // will run at most one extra drain (drain is idempotent against
    // a non-armed controller and self-disarms when settled).
    const tick = async () => {
      if (this._armed) await this.drain();
      if (this._stopped) return;
      this._worker = setTimeout(tick, cycleMs);
      this._worker.unref();
    };
    this._worker = setTimeout(tick, cycleMs);
    this._worker.unref();
  }

  /** Stop the per-lane worker. Idempotent. */
  stop(): void {
    this._stopped = true;
    if (this._worker) {
      clearTimeout(this._worker);
      this._worker = undefined;
    }
  }

  /** Run one drain pass. Short-circuits when not armed or already running. */
  async drain(options: DrainOptions = {}): Promise<Drain<TEvents>> {
    if (!this._armed) return EMPTY_DRAIN as Drain<TEvents>;
    if (this._locked) return EMPTY_DRAIN as Drain<TEvents>;
    // Circuit open: the store is failing, skip the claim entirely so we
    // don't hammer a down backend. `_armed` stays set, so the next tick
    // after the cooldown (half-open) retries.
    if (!this._deps.breaker.can_attempt(Date.now()))
      return EMPTY_DRAIN as Drain<TEvents>;

    const d = this._deps.defaults ?? {};
    // Per-lane config wins over caller options (ACT-1103). The whole
    // point of `withLane({leaseMillis: 30_000})` is to give the slow
    // lane its own budget — a caller-level drain({leaseMillis}) would
    // erase it. Caller options apply only when the lane didn't pin a
    // value.
    const streamLimit = d.streamLimit ?? options.streamLimit ?? 10;
    const eventLimit = d.eventLimit ?? options.eventLimit ?? 10;
    const leaseMillis = d.leaseMillis ?? options.leaseMillis ?? 10_000;

    try {
      this._locked = true;
      const lagging = Math.ceil(streamLimit * this._ratio);
      const leading = streamLimit - lagging;

      const cycle = await run_drain_cycle(
        this._deps.ops,
        this._deps.registry,
        this._deps.batch_handlers,
        this._deps.handle,
        this._deps.handle_batch,
        lagging,
        leading,
        eventLimit,
        leaseMillis,
        this._backoff.size > 0 ? this.is_deferred : undefined,
        this._deps.lane
      );

      // The store responded (claim/fetch/ack/block all succeeded) — reset
      // the breaker even when there was no work to do.
      this._deps.breaker.record_success();

      if (!cycle) {
        // claim() returned no leases — fully caught up
        this._armed = false;
        return EMPTY_DRAIN as Drain<TEvents>;
      }

      const { leased, fetched, handled, acked, blocked } = cycle;

      // Cycle-level trace (ACT-1103) — one log line per drain pass:
      // claim + fetch + outcomes folded together so the operator sees
      // a single atomic narrative for each cycle. No-op when the
      // logger isn't at trace level.
      trace_cycle(this._deps.logger, leased, fetched, handled, acked, blocked);

      // Adapt next cycle's frontier split to where the pressure is.
      this._ratio = compute_lag_lead_ratio(handled, lagging, leading);

      // Refresh per-stream backoff state from this cycle's outcomes.
      // Successful acks and terminal blocks both clear the window;
      // retry-not-block results carry a `next_attempt_at` set by `_finalize`.
      for (const lease of acked) this._backoff.delete(lease.stream);
      for (const lease of blocked) this._backoff.delete(lease.stream);
      for (const h of handled) {
        if (h.next_attempt_at !== undefined && !h.block) {
          this._backoff.set(h.lease.stream, h.next_attempt_at);
        }
      }
      if (this._backoff.size > 0) this.schedule_backoff_wake();

      if (acked.length) this._deps.on_acked(acked);
      if (blocked.length) this._deps.on_blocked(blocked);

      // Disarm only when fully caught up. Errors keep the flag set so
      // retries flow through the next drain.
      const has_errors = handled.some(({ error }) => error);
      if (!acked.length && !blocked.length && !has_errors) this._armed = false;

      return { fetched, leased, acked, blocked };
    } catch (error) {
      // A store op threw (StoreError, or any failure mid-cycle). Record it
      // on the breaker, log it, and surface it to the orchestrator's
      // `error` lifecycle event. `_armed` stays set so the next tick after
      // the cooldown retries. EMPTY_DRAIN keeps the worker tick exception-free.
      const circuit = this._deps.breaker.record_failure(Date.now());
      this._deps.logger.error(error);
      this._deps.on_error(error, circuit);
      return EMPTY_DRAIN as Drain<TEvents>;
    } finally {
      this._locked = false;
    }
  }
}
