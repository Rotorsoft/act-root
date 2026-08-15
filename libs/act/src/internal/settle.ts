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
  /**
   * Whether `correlate` actually probes the store (the app has dynamic
   * resolvers). When false, correlate is a pure no-op early-return that
   * touches no store — so a settle pass has NO store-health signal and must
   * NOT record a breaker `passed()`. Recording a fictitious success there
   * would re-close an OPEN breaker mid-outage on a static-reaction app and
   * let the following drain hammer the down store (#1329). The drain loop's
   * own `passed()`/`failed()` on its real claim keeps the breaker accurate.
   */
  readonly correlate_probes_store: boolean;
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
   * Resolves when the cycle currently in flight finishes; `undefined` when
   * idle (#1468). `_running` answers "is a cycle running?" for the
   * re-arm bookkeeping; this answers "tell me when it is done" for a
   * graceful shutdown.
   *
   * `stop()` only cancels *scheduling* — a cycle already inside its
   * correlate → drain loop keeps going, and because `DrainController.drain`
   * does not consult `_stopped`, it can claim a stream after teardown
   * returned and after the store adapter was disposed. Never rejects: the
   * cycle's own `catch` contains its errors, so awaiting this is safe.
   */
  private _inflight: Promise<void> | undefined;
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
        // operators to sum `drain.fetched` for throughput (#1383).
        let settled_drain: Drain<TEvents> | undefined;
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
          // But only record the success when correlate actually PROBED the
          // store: a static-reaction app's correlate is a no-op early-return
          // that touches nothing, so a `passed()` here would fictitiously
          // re-close an OPEN breaker mid-outage and let the drain below
          // hammer the down store (#1329). drain's own passed()/failed() on
          // its real claim keeps the breaker accurate for those apps.
          if (this._deps.correlate_probes_store) this._deps.breaker.passed();
          const drain = await this._deps.drain(drain_options);
          settled_drain = settled_drain
            ? {
                fetched: [...settled_drain.fetched, ...drain.fetched],
                leased: [...settled_drain.leased, ...drain.leased],
                acked: [...settled_drain.acked, ...drain.acked],
                blocked: [...settled_drain.blocked, ...drain.blocked],
              }
            : drain;
          // `last_id > after_before` counts correlate consuming events as
          // progress even when nothing subscribed or drained this pass — a
          // bounded correlate window (`limit`) full of inert events would
          // otherwise break the loop before a reactive event just past the
          // window is ever scanned. Terminates: ids are monotonic and
          // finite, so once no events remain `last_id === after_before`.
          const made_progress =
            subscribed > 0 ||
            drain.acked.length > 0 ||
            drain.blocked.length > 0 ||
            last_id > after_before;
          if (!made_progress) break;
        }
        // The `.catch` below treats anything it sees as a store failure,
        // because everything else in this block is one. An uncontained
        // listener throw was therefore recorded via `breaker.failed()` —
        // surfacing a spurious `error` event on every settle, and, at
        // `failureThreshold: 1`, opening the breaker so `drain` returned
        // EMPTY_DRAIN for the whole cooldown. Each half-open recovery
        // re-tripped it, so a broken metrics bridge stalled the reaction
        // pipeline indefinitely (#1436). Containment now lives in
        // `Act.emit`, which guards each listener individually (#1437), so
        // no throw escapes `on_settled` to reach that catch.
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
          // options so the requested drain actually happens (ACT-1205).
          const pending = this._pending;
          if (pending !== undefined) {
            this._pending = undefined;
            this.schedule(pending);
          }
        });
    }, debounceMs);
  }

  /**
   * The cycle currently in flight, or `undefined` when idle (#1468). A
   * graceful shutdown awaits this alongside the drain controllers so a
   * settle parked in `correlate` does not resume after teardown.
   */
  get inflight(): Promise<void> | undefined {
    return this._inflight;
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
