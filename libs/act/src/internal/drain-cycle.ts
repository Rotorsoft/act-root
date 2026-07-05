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
  CloseTarget,
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
import type { CircuitBreaker } from "./circuit-breaker.js";
import { DeferTimer } from "./defer-timer.js";
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
   * Wall-clock timestamp (ms since epoch) at which this stream should be
   * re-visited. Set by a handler that *defers* instead of acking or
   * failing: the triggering events stay pending (watermark not advanced),
   * `retry` is not bumped (a defer is not a failure), and the drain holds
   * the stream until `defer` elapses, then redelivers so the handler can
   * re-evaluate. This is the timing primitive autoclose rides (#1090);
   * unlike {@link next_attempt_at} (a retry-only backoff), a defer carries
   * no error and never blocks. When present, the result is excluded from
   * ack and block — it neither advances nor terminates the watermark.
   */
  defer?: number;
  /**
   * Close request (#1090). Set when a handler throws `CloseSignal` to retire
   * its stream: the triggering event is acked (so the closing reaction isn't
   * seen as an in-flight consumer by the close-cycle safety guard) and the
   * drain hands this {@link CloseTarget} to the orchestrator's `on_close`,
   * which runs `run_close_cycle`. Carries the optional archiver from the
   * signal. Distinct from {@link defer} (hold for later) — a close advances
   * and retires.
   */
  close?: CloseTarget;
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
 * A failed durable defer write (#1124). One entry per due-time group whose
 * `ops.defer` rejected; the streams stay pending with no `deferred_at`, so
 * they are immediately re-claimable — the next delivery re-evaluates the
 * handler, which re-throws its `DeferSignal`, and the persist is retried.
 *
 * @internal
 */
export type DeferError = {
  readonly at: number;
  readonly streams: string[];
  readonly error: unknown;
};

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
  /** Streams a handler asked to close this cycle (#1090) — handed to `on_close`. */
  readonly closeable: CloseTarget[];
  /**
   * Durable defer writes that failed this cycle (#1124). Never aborts
   * finalization — close requests and lifecycle events from the same cycle
   * must not be lost to a failed schedule write. The controller feeds these
   * to the circuit breaker (operator signal + paced re-drive) and leaves the
   * affected streams unparked so redelivery heals the durable record.
   */
  readonly defer_errors: DeferError[];
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
      closeable: [],
      defer_errors: [],
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
  //
  // A *deferred* result (#1090) is held out of ack entirely: the handler
  // chose to re-visit the stream later without advancing the watermark, so
  // the pending events must stay pending for the redelivery.
  const acked = await ops.ack(
    handled
      .filter((h) => h.defer === undefined && (h.handled > 0 || !h.error))
      .map((h) => ({ ...h.lease, at: h.acked_at }))
  );

  const blocked = await ops.block(
    handled
      .filter(({ block }) => block)
      .map(({ lease, error }) => ({ ...lease, error: error! }))
  );

  // Persist deferred streams' next-visit time (#1090). `claim()` skips a
  // stream until its `deferred_at` passes, so the defer holds across every
  // competing worker (the durable counterpart to the in-process wake timer)
  // and the stream isn't re-claimed — `retry` stays untouched. `defer()`
  // sets one time per call, so group streams by their due-time.
  //
  // A failed write is collected, never thrown (#1124): the close requests
  // below were already acked, so aborting here would drop them permanently
  // (the terminal event is never redelivered). The affected streams keep no
  // `deferred_at` and stay immediately re-claimable — redelivery re-runs the
  // handler, which re-throws its `DeferSignal`, and the persist is retried.
  const defer_errors: DeferError[] = [];
  const deferrals = handled.filter((h) => h.defer !== undefined);
  if (deferrals.length) {
    const by_time = new Map<number, string[]>();
    for (const h of deferrals) {
      const list = by_time.get(h.defer!);
      if (list) list.push(h.lease.stream);
      else by_time.set(h.defer!, [h.lease.stream]);
    }
    for (const [at, streams] of by_time) {
      try {
        await ops.defer(streams, at);
      } catch (error) {
        defer_errors.push({ at, streams, error });
      }
    }
  }

  // Collect close requests (#1090). A close result was already acked above
  // (its event made progress, `defer === undefined`), which advances the
  // requesting reaction past the terminal event so the close-cycle safety
  // guard doesn't count it as an in-flight consumer. The orchestrator's
  // `on_close` runs the actual `run_close_cycle`.
  const closeable = handled
    .filter((h) => h.close !== undefined)
    .map((h) => h.close!);

  return { leased, fetched, handled, acked, blocked, closeable, defer_errors };
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
   * Close requested by a reaction (#1090). The controller calls this with the
   * cycle's {@link CloseTarget}s after acks/blocks land; the orchestrator wires
   * it to its `run_close_cycle` machinery (same path as `app.close`). Awaited so
   * a slow close doesn't overlap the next cycle's claim on the controller.
   */
  readonly on_close: (targets: CloseTarget[]) => Promise<void>;
  /**
   * Shared, orchestrator-owned circuit breaker (ACT-984). Trips after
   * repeated store failures so the drain loop stops hammering a down
   * backend; closed/half-open let attempts through. It also surfaces each
   * failure (via its own `on_error`, wired by the orchestrator to the
   * `error` lifecycle event), so callers just `failed(now, error)`.
   */
  readonly breaker: CircuitBreaker;
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
   * Per-stream re-visit schedule (#1090): `stream → next visit` (ms since
   * epoch). Holds both retry backoff (`HandleResult.next_attempt_at`) and the
   * `defer` outcome; cleared on successful ack or terminal block. Lives in
   * process memory — per-worker pacing by design (see {@link BackoffOptions}
   * for the multi-worker trade-off). Its wake re-arms drain at the earliest
   * pending visit.
   */
  private readonly _defer = new DeferTimer(() => {
    this._armed = true;
  });
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
    // Drop any pending re-visit wake — the parked set is process-local and
    // rebuilt from the log on the next start (#1090).
    this._defer.stop();
  }

  /** Run one drain pass. Short-circuits when not armed or already running. */
  async drain(options: DrainOptions = {}): Promise<Drain<TEvents>> {
    if (!this._armed) return EMPTY_DRAIN as Drain<TEvents>;
    if (this._locked) return EMPTY_DRAIN as Drain<TEvents>;
    // Circuit open: the store is failing, skip the claim entirely so we
    // don't hammer a down backend. `_armed` stays set, so the next tick
    // after the cooldown (half-open) retries.
    if (this._deps.breaker.state(Date.now()) === "open")
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
        this._defer.size > 0 ? this._defer.is_deferred : undefined,
        this._deps.lane
      );

      if (!cycle) {
        // claim() returned no leases — fully caught up. The store responded,
        // so reset the breaker.
        this._deps.breaker.passed();
        this._armed = false;
        return EMPTY_DRAIN as Drain<TEvents>;
      }

      const { leased, fetched, handled, acked, blocked, closeable } = cycle;

      // Breaker accounting (#1124). A failed durable defer write is a store
      // failure even though the rest of the cycle landed: feed it to the
      // breaker (operator signal via the `error` lifecycle event + the
      // breaker's paced retry probe re-drives settle, so redelivery is
      // guaranteed even on the default lane). Skipping `passed()` here is
      // deliberate — consecutive defer-only failures must still escalate
      // toward an open circuit instead of being reset by the healthy claim.
      if (cycle.defer_errors.length) {
        const streams = cycle.defer_errors.flatMap((d) => d.streams);
        this._deps.breaker.failed(
          Date.now(),
          new Error(
            `defer persist failed for ${streams.length} stream(s) [${streams.join(", ")}] — pending events stay claimable and redelivery will retry the schedule`,
            { cause: cycle.defer_errors[0].error }
          )
        );
      } else {
        // The store responded (claim/fetch/ack/block/defer all succeeded) —
        // reset the breaker even when there was no work to do.
        this._deps.breaker.passed();
      }

      // Cycle-level trace (ACT-1103) — one log line per drain pass:
      // claim + fetch + outcomes folded together so the operator sees
      // a single atomic narrative for each cycle. No-op when the
      // logger isn't at trace level.
      trace_cycle(this._deps.logger, leased, fetched, handled, acked, blocked);

      // Adapt next cycle's frontier split to where the pressure is.
      this._ratio = compute_lag_lead_ratio(handled, lagging, leading);

      // Refresh per-stream re-visit state from this cycle's outcomes.
      // Successful acks and terminal blocks both clear the window;
      // retry-not-block results carry a `next_attempt_at` set by `_finalize`,
      // and deferred results carry a `defer` due-time (#1090). Both park the
      // stream in `_defer` so the shared wake timer re-arms drain at the
      // earliest pending visit. `handle` already reconciles a stream's
      // reactions into a single result per cycle, so the value written here
      // is authoritative for the stream — a plain overwrite, not a merge.
      // Streams whose durable defer write failed are NOT parked locally
      // (#1124): parking would delay this worker's redelivery to the due
      // time while no `deferred_at` protects the schedule across workers or
      // restarts. Left unparked, the next drain redelivers immediately, the
      // handler re-throws its `DeferSignal`, and the persist is retried —
      // the durable record heals at the next healthy cycle.
      const failed_defers = new Set(
        cycle.defer_errors.flatMap((d) => d.streams)
      );
      for (const lease of acked) this._defer.delete(lease.stream);
      for (const lease of blocked) this._defer.delete(lease.stream);
      for (const h of handled) {
        const next = h.defer ?? (h.block ? undefined : h.next_attempt_at);
        if (next !== undefined && !failed_defers.has(h.lease.stream))
          this._defer.set(h.lease.stream, next);
      }
      if (this._defer.size > 0) this._defer.schedule();

      if (acked.length) this._deps.on_acked(acked);
      if (blocked.length) this._deps.on_blocked(blocked);
      // Run reaction-requested closes after acks land (#1090) — the close
      // targets were acked above, so the close-cycle guard sees the requesting
      // reaction as caught up. Awaited so a slow close doesn't overlap the
      // next claim.
      if (closeable.length) await this._deps.on_close(closeable);

      // Disarm only when fully caught up. Errors keep the flag set so
      // retries flow through the next drain — including failed defer writes
      // (#1124), whose streams must be redelivered to heal their schedule.
      const has_errors =
        handled.some(({ error }) => error) || cycle.defer_errors.length > 0;
      if (!acked.length && !blocked.length && !has_errors) this._armed = false;

      return { fetched, leased, acked, blocked };
    } catch (error) {
      // A store op threw (StoreError, or any failure mid-cycle). Record it
      // on the breaker, which logs it and surfaces the `error` lifecycle
      // event. `_armed` stays set so the breaker's retry re-attempts after
      // the cooldown. EMPTY_DRAIN keeps the worker tick exception-free.
      this._deps.breaker.failed(Date.now(), error);
      return EMPTY_DRAIN as Drain<TEvents>;
    } finally {
      this._locked = false;
    }
  }
}
