/**
 * The drain pipeline: {@link run_drain_cycle} is one stateless
 * claim → fetch → dispatch → ack/block round-trip; {@link DrainController}
 * owns the armed flag, the lock, the lag/lead ratio and the defer wake.
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
  Resolved,
  SchemaRegister,
  Schemas,
} from "../types/index.js";
import { AppCodeError } from "./app-code-error.js";
import { compute_backoff_delay } from "./backoff.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import {
  DEFAULT_BACKOFF,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_LEASE_MILLIS,
  DEFAULT_STREAM_LIMIT,
} from "./config.js";
import { DeferTimer } from "./defer-timer.js";
import type { DrainOps } from "./drain.js";
import { compute_lag_lead_ratio } from "./drain-ratio.js";
import { report_once } from "./report-once.js";
import { trace_cycle } from "./tracing.js";

/** Outcome of handling one leased stream; drives its ack/block. */
export type HandleResult = Readonly<{
  lease: Lease;
  handled: number;
  /** Last successful event id, or `lease.at` when there was no work. */
  acked_at: number;
  error?: string;
  block?: boolean;
  /** Epoch ms of the next retry, from the backoff. Only set on a retry. */
  next_attempt_at?: number;
  /** Epoch ms to redeliver a deferred stream; no error, no retry bump. */
  defer?: number;
  /** From a `CloseSignal`; acked first so the close guard sees it caught up. */
  close?: CloseTarget;
  /** Event id that threw (sparse ids make it differ from `acked_at + 1`); never in batch mode. */
  failed_at?: number;
}>;

/** `Act.handle`. */
export type Handle<TEvents extends Schemas> = (
  lease: Lease,
  payloads: ReactionPayload<TEvents>[]
) => Promise<HandleResult>;

/** `Act.handle_batch`. */
export type HandleBatch<TEvents extends Schemas> = (
  lease: Lease,
  payloads: ReactionPayload<TEvents>[],
  batchHandler: BatchHandler<TEvents>
) => Promise<HandleResult>;

type DrainCycle<TEvents extends Schemas> = {
  readonly leased: Lease[];
  readonly fetched: Fetch<TEvents>;
  readonly handled: HandleResult[];
  readonly acked: Lease[];
  readonly blocked: BlockedLease[];
  readonly closeable: CloseTarget[];
};

/**
 * Blocks a stream whose retries were all spent losing the lease (no handler
 * error ever reached the block decision). Strictly `> maxRetries`: the final
 * attempt runs at `=== maxRetries`. Stands down while the store is failing,
 * since `claim` counts retries no handler earned.
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
  const error = `Blocking ${lease.stream} after ${lease.retry} claims with no acknowledged progress — the retry budget (${options.maxRetries}) was spent without the handler ever reporting an error. That means every attempt lost its lease before it could ack: move the reaction to a lane whose leaseMillis covers the handler, then unblock the stream.`;
  log().error(error);
  return { lease, handled: 0, acked_at: lease.at, error, block: true };
}

/**
 * A failed fetch has no payloads to say which reaction it was for, so take
 * the most conservative policy: block only if every reaction does, after
 * the largest budget.
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
 * A resolver threw while matching a leased stream's events. Only that
 * stream fails: it retries on the reaction's backoff and blocks when the
 * reaction's budget is spent, like a failing handler.
 */
function resolver_failed(
  lease: Lease,
  { error, options }: { error: AppCodeError; options: ReactionOptions }
): HandleResult {
  log().error(error);
  const block = options.blockOnError && lease.retry >= options.maxRetries;
  return {
    lease,
    handled: 0,
    acked_at: lease.at,
    error: error.message,
    ...(block
      ? { block: true }
      : {
          next_attempt_at:
            Date.now() +
            compute_backoff_delay(
              lease.retry,
              options.backoff ?? DEFAULT_BACKOFF
            ),
        }),
  };
}

/** Reported once per declaration; every key part is declared, so it stays bounded. */
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

type CycleInput = {
  readonly lagging: number;
  readonly leading: number;
  readonly eventLimit: number;
  readonly leaseMillis: number;
  readonly misrouted: Set<string>;
  readonly store_failing: boolean;
};

/** One drain cycle; `undefined` when nothing was claimed. */
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

  const fetched = await ops.fetch(leased, eventLimit);

  type FetchEntry = (typeof fetched)[number];
  const fetch_map = new Map<
    string,
    {
      fetch: FetchEntry;
      payloads: ReactionPayload<TEvents>[];
      failed?: { error: AppCodeError; options: ReactionOptions };
    }
  >();

  const fetch_window_at = fetched.reduce(
    (max, { at, events }) => Math.max(max, events.at(-1)?.id || at),
    0
  );

  for (const f of fetched) {
    const { stream, events } = f;
    let failed: { error: AppCodeError; options: ReactionOptions } | undefined;
    const payloads = events.flatMap((event) => {
      const register = registry.events[event.name];
      if (!register) return [];
      return [...register.reactions.values()]
        .filter((reaction) => {
          const resolver = reaction.resolver;
          const dynamic = typeof resolver === "function";
          let resolved: Resolved | undefined;
          try {
            resolved = dynamic ? resolver(event) : resolver;
          } catch (error) {
            failed ??= {
              error: new AppCodeError(
                `Resolver of reaction "${reaction.handler.name}" threw on ${String(event.name)} #${event.id} (stream "${event.stream}")`,
                error
              ),
              options: reaction.options,
            };
            return false;
          }
          if (!resolved || resolved.target !== stream) return false;
          // A dynamic resolution onto a projection's target: skip and report.
          // Not a throw, which would read as a store failure.
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
    fetch_map.set(stream, { fetch: f, payloads, failed });
  }

  const handled = await Promise.all(
    leased.map((lease) => {
      const entry = fetch_map.get(lease.stream)!;
      // Retried after the default backoff; blocks once the budget is spent,
      // unless the whole store is failing (the breaker's job).
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
          ...(block
            ? { block: true }
            : {
                next_attempt_at:
                  Date.now() +
                  compute_backoff_delay(lease.retry, DEFAULT_BACKOFF),
              }),
        };
        return Promise.resolve(failed);
      }
      // A resolver threw: this stream fails like a handler would.
      if (entry.failed)
        return Promise.resolve(resolver_failed(lease, entry.failed));
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

  // `block` before `ack`: block needs the lease, ack releases it. A
  // partial-progress block goes to both. Deferred and backing-off entries
  // carry `due`, so one `ack` also persists the schedule (defer: retry -1).
  const blocked = await ops.block(
    handled
      .filter(({ block }) => block)
      .map(({ lease, error }) => ({ ...lease, error: error! }))
  );

  // Before the `ack`, so an ack failure can't lose the terminal event.
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

  // `ack` drops entries whose lease another worker took (deferred entries
  // are never returned).
  const expected = submitted.filter((l) => l.due === undefined).length;
  if (acked.length < expected)
    log().warn(
      `drain: ${expected - acked.length} of ${expected} acks were dropped — the lease was taken by another worker mid-handler. That work will be redelivered (at-least-once), but persistent drops mean leaseMillis is too short for this handler.`
    );

  const closeable = handled
    .filter((h) => h.close !== undefined)
    .map((h) => h.close!);

  return { leased, fetched, handled, acked, blocked, closeable };
}

const EMPTY_DRAIN: Drain<Schemas> = {
  fetched: [],
  leased: [],
  acked: [],
  blocked: [],
};

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
  /** Awaited, so a slow close doesn't overlap the next claim. */
  readonly on_close: (targets: CloseTarget[]) => Promise<void>;
  readonly breaker: CircuitBreaker;
  /** The worker ticks outside any caller frame, so its drain is re-scoped. */
  readonly run_scoped: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Lane this controller drains. Undefined spans all lanes. */
  readonly lane?: string;
  /** The lane's own config; it wins over the caller's DrainOptions. */
  readonly defaults?: {
    readonly streamLimit?: number;
    readonly leaseMillis?: number;
  };
};

export class DrainController<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
> {
  private _armed = false;
  private _locked = false;
  private _ratio = 0.5;
  /**
   * Local wake at the earliest parked (backoff or defer) visit; the schedule
   * itself is persisted. On an idle app nothing else would drain it. A due
   * entry stays until handled or until a later pass claims nothing.
   */
  private readonly _defer = new DeferTimer(() => {
    this._armed = true;
    void this._deps.run_scoped(() => this.drain());
  });
  private _worker: ReturnType<typeof setTimeout> | undefined;
  private readonly _misrouted = new Set<string>();
  private _stopped = false;
  /** Never rejects; graceful shutdown waits on it. */
  private _inflight: Promise<void> | undefined;
  private _inflight_done: (() => void) | undefined;

  private readonly _deps: DrainControllerDeps<TEvents, TActions, TSchemaReg>;

  constructor(deps: DrainControllerDeps<TEvents, TActions, TSchemaReg>) {
    this._deps = deps;
  }

  arm(): void {
    this._armed = true;
  }

  /** Cold start: re-seed a persisted `deferred_at` into the local wake. */
  seed_defer(stream: string, at: number): void {
    this._defer.set(stream, at);
    this._defer.schedule();
  }

  get armed(): boolean {
    return this._armed;
  }

  get inflight(): Promise<void> | undefined {
    return this._inflight;
  }

  /** This lane's configured lease, or `undefined`; the shutdown grace basis. */
  get lease_millis(): number | undefined {
    return this._deps.defaults?.leaseMillis;
  }

  get lane(): string | undefined {
    return this._deps.lane;
  }

  /** Drains every `cycleMs` while armed; the unref'd timer never holds the process. */
  start(cycleMs: number): void {
    if (this._worker || this._stopped) return;
    // `drain()` never throws.
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

  stop(): void {
    this._stopped = true;
    if (this._worker) {
      clearTimeout(this._worker);
      this._worker = undefined;
    }
    this._defer.stop();
  }

  async drain(options: DrainOptions = {}): Promise<Drain<TEvents>> {
    if (!this._armed) return EMPTY_DRAIN as Drain<TEvents>;
    if (this._locked) return EMPTY_DRAIN as Drain<TEvents>;

    const d = this._deps.defaults ?? {};
    // A lane's own budget wins over caller options.
    const streamLimit =
      d.streamLimit ?? options.streamLimit ?? DEFAULT_STREAM_LIMIT;
    const eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
    const leaseMillis =
      d.leaseMillis ?? options.leaseMillis ?? DEFAULT_LEASE_MILLIS;

    // Circuit open: stay armed and leave the wake alone (re-aiming would fire
    // at once for anything due); the breaker's own wake re-aims it.
    if (this._deps.breaker.state(Date.now()) === "open")
      return EMPTY_DRAIN as Drain<TEvents>;

    try {
      this._locked = true;
      this._inflight = new Promise<void>((done) => {
        this._inflight_done = done;
      });
      const lagging = Math.ceil(streamLimit * this._ratio);
      const leading = streamLimit - lagging;

      const started = Date.now();
      const cycle = await run_drain_cycle(this._deps, {
        lagging,
        leading,
        eventLimit,
        leaseMillis,
        misrouted: this._misrouted,
        store_failing: this._deps.breaker.failing,
      });

      if (!cycle) {
        // Caught up: whatever was due when this pass started has no work.
        this._defer.prune(started);
        this._deps.breaker.passed();
        this._armed = false;
        return EMPTY_DRAIN as Drain<TEvents>;
      }

      const { leased, fetched, handled, acked, blocked, closeable } = cycle;

      trace_cycle(this._deps.logger, leased, fetched, handled, acked, blocked);

      this._ratio = compute_lag_lead_ratio(handled, lagging, leading);

      for (const lease of acked) this._defer.delete(lease.stream);
      for (const lease of blocked) this._defer.delete(lease.stream);
      for (const h of handled) {
        const next = h.defer ?? h.next_attempt_at;
        if (next !== undefined) this._defer.set(h.lease.stream, next);
      }

      // Listener throws are contained in `Act.emit`.
      if (acked.length) this._deps.on_acked(acked);
      // Not contained: a store error inside the close machinery is a real
      // store failure and must reach the breaker.
      if (closeable.length) await this._deps.on_close(closeable);

      // After `on_close`, so a failed close never counts as a store success.
      this._deps.breaker.passed();

      // Errors keep the flag set so retries flow through the next drain.
      const has_errors = handled.some(({ error }) => error);
      if (!acked.length && !blocked.length && !has_errors) this._armed = false;

      return { fetched, leased, acked, blocked };
    } catch (error) {
      // App code (a close's archive callback) is logged, never counted as a
      // store failure. A store op that threw: stay armed, retry after the
      // cooldown.
      if (error instanceof AppCodeError) this._deps.logger.error(error);
      else this._deps.breaker.failed(Date.now(), error);
      return EMPTY_DRAIN as Drain<TEvents>;
    } finally {
      // Re-aim at the earliest stream still parked.
      if (!this._stopped) this._defer.schedule();
      this._locked = false;
      this._inflight = undefined;
      this._inflight_done?.();
      this._inflight_done = undefined;
    }
  }
}
