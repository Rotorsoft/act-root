/**
 * @module settle
 * @category Internal
 *
 * Debounced correlate→drain loop. Sits one level above both correlation
 * and drain: schedule() coalesces rapid callers into a single cycle, then
 * runs correlate+drain in a loop until a pass produces no progress.
 *
 * Owns the debounce timer and the reentrancy flag. Everything else is
 * supplied via the `SettleDeps` callbacks so this module stays free of
 * orchestrator state.
 *
 * @internal
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
 *
 * @internal
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
 *
 * @internal
 */
export class SettleLoop<TEvents extends Schemas> {
  private _timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private _running = false;
  /**
   * Resolves when the cycle in flight finishes, so shutdown can wait for
   * it (`stop()` cancels scheduling only). Never rejects.
   */
  private _inflight: Promise<void> | undefined;
  /**
   * A wake-up that fired while a cycle was running. The running cycle's
   * `finally` schedules one more pass with these options, so it isn't lost.
   */
  private _pending: SettleOptions | undefined = undefined;
  private readonly _deps: SettleDeps<TEvents>;
  /** Debounce window applied when the caller doesn't override via `SettleOptions.debounceMs`. */
  private readonly _default_debounce_ms: number;

  constructor(deps: SettleDeps<TEvents>, default_debounce_ms: number) {
    this._deps = deps;
    this._default_debounce_ms = default_debounce_ms;
  }

  /**
   * Schedule a settle pass. Multiple calls inside the debounce window
   * coalesce into one cycle. The cycle runs correlate→drain in a loop
   * until no progress is made (no new subscriptions, no acks, no blocks)
   * or `maxPasses` is reached, then emits the `"settled"` lifecycle event
   * via {@link SettleDeps.on_settled}.
   */
  schedule(options: SettleOptions = {}): void {
    const {
      debounceMs = this._default_debounce_ms,
      correlate: correlate_query = { after: -1, limit: 100 },
      maxPasses = Infinity,
      ...drain_options
    } = options;

    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = undefined;
      // A cycle is already running. Record this wake-up as pending rather
      // than dropping it — the running cycle's `finally`
      // re-schedules it so armed controllers always get one more drain.
      if (this._running) {
        this._pending = options;
        return;
      }
      this._running = true;

      let settle_done!: () => void;
      this._inflight = new Promise<void>((done) => {
        settle_done = done;
      });

      (async () => {
        await this._deps.init();
        // Accumulated across every pass, so `settled` reports what the
        // SETTLE did rather than what its last pass did. The loop only
        // exits on a pass that made no progress, so emitting that pass
        // alone meant the payload was always empty — while the guide tells
        // operators to sum `drain.fetched` for throughput.
        let settled_drain: Drain<TEvents> | undefined;
        // Loop correlate→drain until a pass produces no work — this fully
        // catches up paginated streams (e.g. after `reset()` on a long
        // projection) without forcing callers to roll their own loop.
        // `maxPasses` caps runtime in pathological cases.
        for (let i = 0; i < maxPasses; i++) {
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
          // Reading events counts as progress even when nothing reacted, so a
          // window of inert events can't stop the loop short. It still ends:
          // ids are finite.
          const made_progress =
            subscribed > 0 ||
            drain.acked.length > 0 ||
            drain.blocked.length > 0 ||
            last_id > after_before;
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
          // A wake-up arrived mid-cycle. Re-arm one more pass with its
          // options so the requested drain actually happens.
          const pending = this._pending;
          if (pending !== undefined) {
            this._pending = undefined;
            this.schedule(pending);
          }
        });
    }, debounceMs);
  }

  /**
   * The cycle currently in flight, or `undefined` when idle. A
   * graceful shutdown awaits this alongside the drain controllers so a
   * settle parked in `correlate` does not resume after teardown.
   */
  get inflight(): Promise<void> | undefined {
    return this._inflight;
  }

  /** Cancel any pending or active settle cycle. Idempotent. */
  stop(): void {
    // Drop a mid-cycle wake-up too — a stopped loop must not re-arm from
    // the running cycle's `finally`.
    this._pending = undefined;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
