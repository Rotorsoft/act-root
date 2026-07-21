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
  ) => Promise<{ subscribed: number; last_id: number }>;
  readonly drain: (options: DrainOptions) => Promise<Drain<TEvents>>;
  readonly on_settled: (drain: Drain<TEvents>) => void;
  /**
   * Shared orchestrator circuit breaker (ACT-984). The settle loop's
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
   * Set when a `schedule()` timer fires while a cycle is still running
   * (ACT-1205). The in-flight cycle's `finally` re-arms one more pass so
   * the wake-up isn't dropped — a commit landing during the final
   * no-progress drain pass would otherwise leave armed controllers with
   * nothing to re-drain on an instance with no lane `cycleMs` and no
   * polling. Carries the options of the dropped call so the re-armed
   * pass honors its `debounceMs`/`maxPasses`/drain overrides.
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
      // than dropping it (ACT-1205) — the running cycle's `finally`
      // re-schedules it so armed controllers always get one more drain.
      if (this._running) {
        this._pending = options;
        return;
      }
      this._running = true;

      (async () => {
        await this._deps.init();
        let last_drain: Drain<TEvents> | undefined;
        // Loop correlate→drain until a pass produces no work — this fully
        // catches up paginated streams (e.g. after `reset()` on a long
        // projection) without forcing callers to roll their own loop.
        // `maxPasses` caps runtime in pathological cases.
        for (let i = 0; i < maxPasses; i++) {
          const after_before = this._deps.checkpoint();
          const { subscribed, last_id } = await this._deps.correlate({
            ...correlate_query,
            after: after_before,
          });
          // correlate (subscribe + query) succeeded — the store responded.
          this._deps.breaker.passed();
          last_drain = await this._deps.drain(drain_options);
          // `last_id > after_before` counts correlate consuming events as
          // progress even when nothing subscribed or drained this pass — a
          // bounded correlate window (`limit`) full of inert events would
          // otherwise break the loop before a reactive event just past the
          // window is ever scanned. Terminates: ids are monotonic and
          // finite, so once no events remain `last_id === after_before`.
          const made_progress =
            subscribed > 0 ||
            last_drain.acked.length > 0 ||
            last_drain.blocked.length > 0 ||
            last_id > after_before;
          if (!made_progress) break;
        }
        if (last_drain) this._deps.on_settled(last_drain);
      })()
        .catch((err) => {
          // correlate / init failed (a store op). Record on the shared
          // breaker, which logs it and surfaces the `error` event; the
          // drain loop reads the same breaker to pace itself.
          this._deps.breaker.failed(Date.now(), err);
        })
        .finally(() => {
          this._running = false;
          // A wake-up arrived mid-cycle. Re-arm one more pass with its
          // options so the requested drain actually happens (ACT-1205).
          const pending = this._pending;
          if (pending !== undefined) {
            this._pending = undefined;
            this.schedule(pending);
          }
        });
    }, debounceMs);
  }

  /** Cancel any pending or active settle cycle. Idempotent. */
  stop(): void {
    // Drop a mid-cycle wake-up too — a stopped loop must not re-arm from
    // the running cycle's `finally` (ACT-1205).
    this._pending = undefined;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
