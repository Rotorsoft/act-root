/**
 * Debounced correlate→drain loop. Sits one level above both correlation
 * and drain: schedule() coalesces rapid callers into a single cycle, then
 * runs correlate+drain in a loop until a pass produces no progress.
 *
 * Owns the debounce timer and the reentrancy flag. Everything else is
 * supplied via the `SettleDeps` callbacks so this module stays free of
 * orchestrator state.
 */

import type {
  Drain,
  DrainOptions,
  Query,
  Schemas,
  SettleOptions,
} from "../types/index.js";
import type { CircuitBreaker } from "./circuit-breaker.js";

/**
 * Callbacks the settle loop needs from the orchestrator. Modeled as an
 * input bag so this file doesn't import `Act` (avoids a cycle) and stays
 * independently testable.
 */
export type SettleDeps<TEvents extends Schemas> = {
  readonly init: () => Promise<void>;
  readonly checkpoint: () => number;
  readonly correlate: (
    query: Query
  ) => Promise<{ subscribed: number; last_id: number; scanned?: boolean }>;
  readonly drain: (options: DrainOptions) => Promise<Drain<TEvents>>;
  readonly on_settled: (drain: Drain<TEvents>) => void;
  /**
   * Shared orchestrator circuit breaker. The settle loop's
   * `correlate` (subscribe + query) is a store consumer too: a successful
   * pass records `passed()`, a failed one `failed(now, err)` — feeding the
   * same breaker that paces the drain loop, which also surfaces the failure
   * to the `error` lifecycle event.
   */
  readonly breaker: CircuitBreaker;
};

/**
 * Drives the debounced correlate→drain catch-up cycle. One instance per
 * Act orchestrator.
 */
export class SettleLoop<TEvents extends Schemas> {
  private _timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private _running = false;
  /**
   * Resolves when the cycle in flight finishes, so shutdown can wait for
   * it (`stop()` cancels scheduling only). Never rejects.
   */
  private _inflight: Promise<void> | undefined;
  /** A wake-up arrived while a cycle ran: run one more pass after it. */
  private _pending = false;
  /** The last caller's options, used by the next pass. */
  private _next: SettleOptions | undefined = undefined;
  /** When the scheduled pass fires (epoch ms). */
  private _due = 0;
  /** Set at shutdown: nothing schedules again. */
  private _stopped = false;
  private readonly _deps: SettleDeps<TEvents>;
  /** Debounce window applied when the caller doesn't override via `SettleOptions.debounceMs`. */
  private readonly _default_debounce_ms: number;

  constructor(deps: SettleDeps<TEvents>, default_debounce_ms: number) {
    this._deps = deps;
    this._default_debounce_ms = default_debounce_ms;
  }

  /**
   * Schedule a settle pass. A pass already scheduled is never put off or
   * replaced: calls that arrive before it runs join it (a shorter
   * `debounceMs` brings it forward), and a call during a running cycle
   * queues one more pass after it. Callers pass options, which the next
   * pass uses; internal wake-ups pass none, so they never discard a
   * caller's. The cycle runs correlate→drain in a
   * loop until no progress is made (no new subscriptions, no events read,
   * no streams leased) or `maxPasses` is reached, then emits the
   * `"settled"` lifecycle event via {@link SettleDeps.on_settled}.
   */
  schedule(options?: SettleOptions): void {
    if (this._stopped) return;
    if (options) this._next = options;
    if (this._running) {
      this._pending = true;
      return;
    }
    const delay = options?.debounceMs ?? this._default_debounce_ms;
    const due = Date.now() + delay;
    if (this._timer) {
      if (due >= this._due) return;
      clearTimeout(this._timer);
    }
    this._due = due;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      const {
        debounceMs: _,
        correlate: correlate_query = {},
        maxPasses = Infinity,
        ...drain_options
      } = this._next ?? {};
      this._next = undefined;
      this._running = true;

      let settle_done!: () => void;
      this._inflight = new Promise<void>((done) => {
        settle_done = done;
      });

      (async () => {
        await this._deps.init();
        // Accumulated across every pass, so `settled` reports what the whole
        // settle did; its last pass made no progress and is always empty.
        let settled_drain: Drain<TEvents> | undefined;
        // Loop correlate→drain until a pass produces no work — this fully
        // catches up paginated streams (e.g. after `reset()` on a long
        // projection) without forcing callers to roll their own loop.
        // `maxPasses` caps runtime in pathological cases.
        // Shutdown waits for the pass in flight, not for the loop.
        for (let i = 0; i < maxPasses && !this._stopped; i++) {
          const after_before = this._deps.checkpoint();
          const { subscribed, last_id, scanned } = await this._deps.correlate({
            ...correlate_query,
            after: after_before,
          });
          // A scan that reached the store and came back is a real health
          // signal; a disarmed pass that returned without touching it is not.
          // Recording the latter would re-close an OPEN breaker mid-outage and
          // let the drain below hammer a store nobody has heard from — so the
          // question is asked per pass.
          if (scanned) this._deps.breaker.passed();
          const drain = await this._deps.drain(drain_options);
          settled_drain = settled_drain
            ? {
                fetched: [...settled_drain.fetched, ...drain.fetched],
                leased: [...settled_drain.leased, ...drain.leased],
                acked: [...settled_drain.acked, ...drain.acked],
                blocked: [...settled_drain.blocked, ...drain.blocked],
              }
            : drain;
          // Only a pass that read no events and leased nothing is idle: a
          // leased stream that deferred or failed may leave work behind. It
          // ends because ids are finite and a leased stream advances or
          // leaves the claimable set (acked, blocked, scheduled); a zero
          // backoff keeps it claimable until it blocks or succeeds.
          const made_progress =
            subscribed > 0 || drain.leased.length > 0 || last_id > after_before;
          if (!made_progress) break;
        }
        // `Act.emit` contains listener throws, so the store-failure catch
        // below never sees one.
        if (settled_drain) this._deps.on_settled(settled_drain);
      })()
        .catch((err) => {
          // correlate / init failed (a store op). Record on the shared
          // breaker, which logs it and surfaces the `error` event; the
          // drain loop reads the same breaker to pace itself.
          this._deps.breaker.failed(Date.now(), err);
        })
        .finally(() => {
          this._running = false;
          this._inflight = undefined;
          settle_done();
          // A wake-up arrived mid-cycle: run one more pass so it isn't lost.
          if (this._pending) {
            this._pending = false;
            this.schedule(this._next);
          }
        });
    }, delay);
  }

  /**
   * The cycle currently in flight, or `undefined` when idle. A
   * graceful shutdown awaits this alongside the drain controllers so a
   * settle parked in `correlate` does not resume after teardown.
   */
  get inflight(): Promise<void> | undefined {
    return this._inflight;
  }

  /**
   * Cancel any pending settle pass. Idempotent. `final` (shutdown) also
   * stops all later scheduling.
   */
  stop(final = false): void {
    if (final) this._stopped = true;
    // Drop a mid-cycle wake-up too — a stopped loop must not re-arm from
    // the running cycle's `finally`.
    this._pending = false;
    this._next = undefined;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
