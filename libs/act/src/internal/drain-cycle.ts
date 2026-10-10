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
 *   the concurrency lock, and the adaptive lag/lead ratio.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";
import { log } from "../ports.js";
import type {
  BatchHandler,
  BlockedLease,
  CloseTarget,
  Drain,
  DrainOptions,
  Fetch,
  Lease,
  Logger,
  ReactionOptions,
  ReactionPayload,
  Registry,
  SchemaRegister,
  Schemas,
} from "../types/index.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import {
  DEFAULT_EVENT_LIMIT,
  DEFAULT_LEASE_MILLIS,
  DEFAULT_STREAM_LIMIT,
} from "./config.js";
import { DeferTimer } from "./defer-timer.js";
import type { DrainOps } from "./drain.js";
import { compute_lag_lead_ratio } from "./drain-ratio.js";
import { report_once } from "./report-once.js";
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
   * Event id at which the ack would land: the last *successful* event id,
   * or `lease.at` when the batch had no work.
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
   * Wall-clock timestamp (ms since epoch) at which to re-visit a stream
   * whose handler *deferred*: the triggering events stay pending, `retry`
   * is not bumped, and the drain redelivers once `defer` elapses. Unlike
   * {@link next_attempt_at}, a defer carries no error and never blocks.
   */
  defer?: number;
  /**
   * Close request from a handler that threw `CloseSignal`. The triggering
   * event is acked (so the close guard doesn't see the reaction as in
   * flight), then the drain hands this {@link CloseTarget} to `on_close`.
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
 * One drain cycle's results. Returned by {@link run_drain_cycle}; consumed by
 * `Act.drain()` to update lifecycle state, the lag/lead ratio, and emit the
 * `acked` / `blocked` lifecycle events.
 *
 * @internal
 */
type DrainCycle<TEvents extends Schemas> = {
  readonly leased: Lease[];
  readonly fetched: Fetch<TEvents>;
  readonly handled: HandleResult[];
  readonly acked: Lease[];
  readonly blocked: BlockedLease[];
  /** Streams a handler asked to close this cycle — handed to `on_close`. */
  readonly closeable: CloseTarget[];
};

/**
 * Terminal result for a stream whose retry budget was spent without a single
 * attempt ever reaching the block decision — or `undefined` when the stream
 * still has budget.
 *
 * Catches a handler that loses its lease every round: it never throws, its
 * ack is dropped, and `retry` climbs while the watermark never moves. The
 * threshold is strictly `> maxRetries` because a stream legitimately reaches
 * `retry === maxRetries` on its final attempt, which `finalize` may still run.
 *
 * Honors `blockOnError: false` like `finalize`, and stands down while the
 * store is failing: `claim` raises `retry` before any handler runs, so a
 * pass that dies on a store call leaves a count no handler earned.
 *
 * @internal
 */
function budget_exhausted<TEvents extends Schemas>(
  lease: Lease,
  options: ReactionPayload<TEvents>["options"] | undefined,
  store_failing: boolean
): HandleResult | undefined {
  if (
    store_failing ||
    !options?.blockOnError ||
    lease.retry <= options.maxRetries
  )
    return undefined;
  const error = `Blocking ${lease.stream} after ${lease.retry} claims with no acknowledged progress — the retry budget (${options.maxRetries}) was spent without the handler ever reporting an error. That means every attempt lost its lease before it could ack: raise leaseMillis for this handler, then unblock the stream.`;
  log().error(error);
  return { lease, handled: 0, acked_at: lease.at, error, block: true };
}

/**
 * The retry policy for a stream whose fetch failed. Retry options
 * belong to reactions and are normally read from the fetched payloads, but
 * a failed fetch has none, so there is no way to tell which reaction the
 * events were for. Take the most conservative policy across every
 * registered reaction: block only if all of them block on error (an
 * operator who opted any reaction out chose "retry forever", and this
 * stream might be its), and only once the largest budget is spent (so no
 * reaction's budget is cut short).
 *
 * @internal
 */
function fetch_failure_policy<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
>(registry: Registry<TSchemaReg, TEvents, TActions>): ReactionOptions {
  let blockOnError = true;
  let maxRetries = 0;
  for (const register of Object.values(registry.events))
    for (const reaction of register.reactions.values()) {
      blockOnError &&= reaction.options.blockOnError;
      maxRetries = Math.max(maxRetries, reaction.options.maxRetries);
    }
  return { blockOnError, maxRetries };
}

/**
 * Report a misrouted resolution once per offending declaration. Every key
 * part is declared, not resolved (`stream` is a projection's static target),
 * so the report count stays bounded by the build.
 */
function warn_misrouted(
  seen: Set<string>,
  stream: string,
  handler: string,
  event: string
): void {
  report_once(
    seen,
    `${stream}|${handler}|${event}`,
    `Reaction "${handler}" on "${event}" resolved to target "${stream}", which a projection already serves. ` +
      "A target is served by one batch handler or one state projection, so this reaction can never run — and delivering to it would hand the projection an aggregate from another stream. " +
      "Skipping it. The equivalent static `.to({ target })` is rejected at build; a dynamic resolver's target is only knowable here."
  );
}

/** One cycle's sizing and per-pass state, from {@link DrainController}. */
type CycleInput = {
  readonly lagging: number;
  readonly leading: number;
  readonly eventLimit: number;
  readonly leaseMillis: number;
  readonly misrouted: Set<string>;
  /** The store failed on the previous pass — see {@link budget_exhausted}. */
  readonly store_failing: boolean;
};

/**
 * Run one drain cycle: claim streams, fetch their events, dispatch
 * matching reactions, ack the successes, block the retries-exhausted.
 *
 * Returns `undefined` when nothing was claimed — caller can short-circuit
 * the rest of the drain pass.
 *
 * **Deferred streams** (backoff windows and explicit defers) are excluded
 * upstream by `claim`: their persisted `deferred_at` gates re-dispatch, so
 * they never reach this cycle until the schedule elapses.
 *
 * @internal
 */
async function run_drain_cycle<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
>(
  deps: DrainControllerDeps<TEvents, TActions, TSchemaReg>,
  cycle: CycleInput
): Promise<DrainCycle<TEvents> | undefined> {
  const { ops, registry, batch_handlers, handle, handle_batch, lane } = deps;
  const {
    lagging,
    leading,
    eventLimit,
    leaseMillis,
    misrouted,
    store_failing,
  } = cycle;
  const leased = await ops.claim(
    lagging,
    leading,
    randomUUID(),
    leaseMillis,
    lane
  );
  if (!leased.length) return undefined;

  // Streams in a backoff or defer window were already excluded by `claim`.
  const fetched = await ops.fetch(leased, eventLimit);

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
          const resolver = reaction.resolver;
          const dynamic = typeof resolver === "function";
          const resolved = dynamic ? resolver(event) : resolver;
          if (!resolved || resolved.target !== stream) return false;
          // A projection's target is served by its batch handler alone. A
          // static reaction onto it is rejected at build, so a dynamic one
          // landing here is the misrouting the build couldn't see: skip it
          // and report once. Not a throw: anything thrown in the cycle reads
          // as a store failure and would stall the drain on the breaker.
          if (!dynamic || !batch_handlers.has(stream)) return true;
          warn_misrouted(
            misrouted,
            stream,
            reaction.handler.name,
            String(event.name)
          );
          return false;
        })
        .map((reaction) => ({ ...reaction, event }));
    });
    fetch_map.set(stream, { fetch: f, payloads });
  }

  const handled = await Promise.all(
    leased.map((lease) => {
      const entry = fetch_map.get(lease.stream)!;
      // This stream's read failed: a no-progress failure for this stream
      // alone (no ack, the lease lapses). It blocks once the retry budget is
      // spent, like a failing handler, except while the whole store is
      // failing, which is the breaker's job.
      if (entry.fetch.error !== undefined) {
        const error = `Fetch failed for ${lease.stream}: ${entry.fetch.error}`;
        log().error(error);
        const policy = fetch_failure_policy(registry);
        const block =
          !store_failing &&
          policy.blockOnError &&
          lease.retry >= policy.maxRetries;
        const failed: HandleResult = {
          lease,
          handled: 0,
          acked_at: lease.at,
          error,
          ...(block ? { block: true } : {}),
        };
        return Promise.resolve(failed);
      }
      // fast-forward watermark using fetched events or window max
      const at = entry.fetch.events.at(-1)?.id || fetch_window_at;
      const { payloads } = entry;
      const exhausted = budget_exhausted(
        lease,
        payloads[0]?.options,
        store_failing
      );
      if (exhausted) return Promise.resolve(exhausted);
      const batchHandler = batch_handlers.get(lease.stream);
      if (batchHandler && payloads.length > 0) {
        return handle_batch({ ...lease, at }, payloads, batchHandler);
      }
      return handle({ ...lease, at }, payloads);
    })
  );

  // Finalize in one atomic `ack`: each entry advances to its last fully
  // handled event (`acked_at`), or stays at the claim watermark when it made
  // no progress. Deferred and backing-off entries carry `due`, so the same
  // call persists the schedule; a backoff keeps the climbing `retry`, a defer
  // passes `retry: -1`.
  //
  // `block` runs before `ack`, because `block` requires the lease and `ack`
  // releases it. A partial-progress-then-block entry goes to both: `block`
  // marks it poison, then `ack` advances past the handled prefix.
  const blocked = await ops.block(
    handled
      .filter(({ block }) => block)
      .map(({ lease, error }) => ({ ...lease, error: error! }))
  );

  // Emitted before the `ack`: a block is terminal, so an `ack` failure in
  // between would otherwise lose the `blocked` event for good.
  if (blocked.length) deps.on_blocked(blocked);

  const submitted = handled.flatMap((h, i) => {
    const advance = h.handled > 0 ? h.acked_at : leased[i].at;
    return h.defer !== undefined
      ? { ...h.lease, at: advance, due: h.defer, retry: -1 }
      : h.next_attempt_at !== undefined
        ? { ...h.lease, at: advance, due: h.next_attempt_at }
        : h.handled > 0 || !h.error
          ? { ...h.lease, at: h.acked_at }
          : [];
  });
  const acked = await ops.ack(submitted);

  // `ack` silently drops entries whose lease another worker took, so compare
  // what was submitted with what landed (deferred entries are never
  // returned). `warn`: the work is redelivered, but persistent drops mean
  // the lease is too short.
  const expected = submitted.filter((l) => l.due === undefined).length;
  if (acked.length < expected)
    log().warn(
      `drain: ${expected - acked.length} of ${expected} acks were dropped — the lease was taken by another worker mid-handler. That work will be redelivered (at-least-once), but persistent drops mean leaseMillis is too short for this handler.`
    );

  // Close requests, already acked above so the close guard sees the
  // requesting reaction as caught up.
  const closeable = handled
    .filter((h) => h.close !== undefined)
    .map((h) => h.close!);

  return { leased, fetched, handled, acked, blocked, closeable };
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
   * Runs the cycle's reaction-requested closes after acks/blocks land.
   * Awaited so a slow close doesn't overlap the next claim.
   */
  readonly on_close: (targets: CloseTarget[]) => Promise<void>;
  /**
   * Shared circuit breaker. Opens after repeated store failures so the
   * drain stops hammering a down backend, and surfaces each failure.
   */
  readonly breaker: CircuitBreaker;
  /**
   * Runs a body in the Act's ports frame. The per-lane worker ticks outside
   * any caller frame, so its drain must be re-scoped.
   */
  readonly run_scoped: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Lane this controller drains. Undefined spans all lanes. */
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
   * Local wake for streams this worker parked (backoff or defer). The
   * schedule itself is persisted in the store; this runs the drain at the
   * earliest pending visit. A parked stream already carries its mark, so
   * the drain alone finds it, and on an idle app nothing else would. It
   * reuses the options of the last drain, which parked the stream. `stop()`
   * cancels the timer and a stopped drain never re-schedules it, so a wake
   * never runs after a stop.
   */
  private readonly _defer = new DeferTimer(() => {
    this._armed = true;
    void this._deps.run_scoped(() => this.drain(this._last_options));
  });
  private _last_options: DrainOptions = {};
  /** Worker timer. Set when `start()` is active, undefined otherwise. */
  private _worker: ReturnType<typeof setTimeout> | undefined;
  /**
   * Misroutings this controller has reported. A resolver returning a
   * projection's target does so for every matching event; one line per event
   * would bury the signal it exists to raise.
   */
  private readonly _misrouted = new Set<string>();
  private _stopped = false;
  /**
   * Resolves when the cycle in flight finishes, so a graceful shutdown can
   * wait for it. Never rejects.
   */
  private _inflight: Promise<void> | undefined;
  private _inflight_done: (() => void) | undefined;

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

  /**
   * Re-seed a persisted `deferred_at` into the local wake at cold start, so
   * an idle deferred stream re-arms at its due-time with no new commit.
   * Seeds collapse into one timer; the earliest wins.
   */
  seed_defer(stream: string, at: number): void {
    this._defer.set(stream, at);
    this._defer.schedule();
  }

  /** Read-only flag — true while a commit / reset is unprocessed. */
  get armed(): boolean {
    return this._armed;
  }

  /** The cycle in flight, or `undefined` when idle. */
  get inflight(): Promise<void> | undefined {
    return this._inflight;
  }

  /** This lane's configured lease, or `undefined`; the shutdown grace basis. */
  get lease_millis(): number | undefined {
    return this._deps.defaults?.leaseMillis;
  }

  /** Lane this controller drains (undefined spans all lanes). */
  get lane(): string | undefined {
    return this._deps.lane;
  }

  /**
   * Start a per-lane worker that drains at the lane's `cycleMs`
   * cadence. When armed, the worker calls `drain()` on every
   * tick and re-schedules; when not armed, it still re-schedules at
   * `cycleMs` so a future `arm()` is picked up on the next tick.
   *
   * The setTimeout chain uses `unref()` so it doesn't keep the process
   * alive on its own.
   */
  start(cycleMs: number): void {
    if (this._worker || this._stopped) return;
    // `drain()` never throws. The `_stopped` check stops re-scheduling after
    // a mid-tick `stop()`.
    const run = this._deps.run_scoped;
    const tick = async () => {
      if (this._armed) await run(() => this.drain());
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
    this._defer.stop();
  }

  /** Run one drain pass. Short-circuits when not armed or already running. */
  async drain(options: DrainOptions = {}): Promise<Drain<TEvents>> {
    this._last_options = options;
    if (!this._armed) return EMPTY_DRAIN as Drain<TEvents>;
    if (this._locked) return EMPTY_DRAIN as Drain<TEvents>;
    // Circuit open: the store is failing, skip the claim entirely so we
    // don't hammer a down backend. `_armed` stays set, so the next tick
    // after the cooldown (half-open) retries.
    if (this._deps.breaker.state(Date.now()) === "open")
      return EMPTY_DRAIN as Drain<TEvents>;

    const d = this._deps.defaults ?? {};
    // Per-lane config wins over caller options: a lane's own budget is the
    // point of `withLane({leaseMillis})`.
    const streamLimit =
      d.streamLimit ?? options.streamLimit ?? DEFAULT_STREAM_LIMIT;
    const eventLimit =
      d.eventLimit ?? options.eventLimit ?? DEFAULT_EVENT_LIMIT;
    const leaseMillis =
      d.leaseMillis ?? options.leaseMillis ?? DEFAULT_LEASE_MILLIS;

    try {
      this._locked = true;
      this._inflight = new Promise<void>((done) => {
        this._inflight_done = done;
      });
      const lagging = Math.ceil(streamLimit * this._ratio);
      const leading = streamLimit - lagging;

      const cycle = await run_drain_cycle(this._deps, {
        lagging,
        leading,
        eventLimit,
        leaseMillis,
        misrouted: this._misrouted,
        store_failing: this._deps.breaker.failing,
      });

      if (!cycle) {
        // Nothing claimed: caught up, and the store answered.
        this._deps.breaker.passed();
        this._armed = false;
        return EMPTY_DRAIN as Drain<TEvents>;
      }

      const { leased, fetched, handled, acked, blocked, closeable } = cycle;

      // One trace line per cycle (no-op unless the logger is at trace).
      trace_cycle(this._deps.logger, leased, fetched, handled, acked, blocked);

      // Adapt next cycle's frontier split to where the pressure is.
      this._ratio = compute_lag_lead_ratio(handled, lagging, leading);

      // Refresh the local wake: acks and blocks clear a stream; a retry
      // (`next_attempt_at`) or defer parks it until its next visit.
      for (const lease of acked) this._defer.delete(lease.stream);
      for (const lease of blocked) this._defer.delete(lease.stream);
      for (const h of handled) {
        // A no-progress failure keeps its lease, so park until it lapses.
        const retry_at =
          h.error && !h.block
            ? (h.next_attempt_at ?? Date.now() + leaseMillis)
            : undefined;
        const next = h.defer ?? retry_at;
        if (next !== undefined) this._defer.set(h.lease.stream, next);
      }

      // Listener throws are contained in `Act.emit`, so they never reach the
      // store-error catch below.
      if (acked.length) this._deps.on_acked(acked);
      // Not contained: a store error inside the close machinery is a real
      // store failure and must reach the breaker.
      if (closeable.length) await this._deps.on_close(closeable);

      // Recorded after `on_close` so a cycle whose close failed is never
      // counted as a store success.
      this._deps.breaker.passed();

      // Disarm only when fully caught up. Errors keep the flag set so
      // retries flow through the next drain.
      const has_errors = handled.some(({ error }) => error);
      if (!acked.length && !blocked.length && !has_errors) this._armed = false;

      return { fetched, leased, acked, blocked };
    } catch (error) {
      // A store op threw. The breaker logs and surfaces it; `_armed` stays
      // set so the next pass retries after the cooldown.
      this._deps.breaker.failed(Date.now(), error);
      return EMPTY_DRAIN as Drain<TEvents>;
    } finally {
      // Re-aim the wake at the earliest stream still parked, including one
      // whose wake fired early at the timer ceiling.
      if (!this._stopped) this._defer.schedule();
      this._locked = false;
      this._inflight = undefined;
      this._inflight_done?.();
      this._inflight_done = undefined;
    }
  }
}
