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
  Logger,
  Query,
  Schemas,
  SettleOptions,
} from "../types/index.js";

/**
 * Callbacks the settle loop needs from the orchestrator. Modeled as an
 * input bag so this file doesn't import `Act` (avoids a cycle) and stays
 * independently testable.
 *
 * @internal
 */
export type SettleDeps<TEvents extends Schemas> = {
  readonly logger: Logger;
  readonly init: () => Promise<void>;
  readonly checkpoint: () => number;
  readonly correlate: (
    query: Query
  ) => Promise<{ subscribed: number; last_id: number }>;
  readonly drain: (options: DrainOptions) => Promise<Drain<TEvents>>;
  readonly onSettled: (drain: Drain<TEvents>) => void;
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

  constructor(
    private readonly deps: SettleDeps<TEvents>,
    /** Debounce window applied when the caller doesn't override via `SettleOptions.debounceMs`. */
    private readonly defaultDebounceMs: number
  ) {}

  /**
   * Schedule a settle pass. Multiple calls inside the debounce window
   * coalesce into one cycle. The cycle runs correlate→drain in a loop
   * until no progress is made (no new subscriptions, no acks, no blocks)
   * or `maxPasses` is reached, then emits the `"settled"` lifecycle event
   * via {@link SettleDeps.onSettled}.
   */
  schedule(options: SettleOptions = {}): void {
    const {
      debounceMs = this.defaultDebounceMs,
      correlate: correlateQuery = { after: -1, limit: 100 },
      maxPasses = Infinity,
      ...drainOptions
    } = options;

    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = undefined;
      if (this._running) return;
      this._running = true;

      (async () => {
        await this.deps.init();
        let lastDrain: Drain<TEvents> | undefined;
        // Loop correlate→drain until a pass produces no work — this fully
        // catches up paginated streams (e.g. after `reset()` on a long
        // projection) without forcing callers to roll their own loop.
        // `maxPasses` caps runtime in pathological cases.
        for (let i = 0; i < maxPasses; i++) {
          const { subscribed } = await this.deps.correlate({
            ...correlateQuery,
            after: this.deps.checkpoint(),
          });
          lastDrain = await this.deps.drain(drainOptions);
          const made_progress =
            subscribed > 0 ||
            lastDrain.acked.length > 0 ||
            lastDrain.blocked.length > 0;
          if (!made_progress) break;
        }
        if (lastDrain) this.deps.onSettled(lastDrain);
      })()
        .catch((err) => this.deps.logger.error(err))
        .finally(() => {
          this._running = false;
        });
    }, debounceMs);
  }

  /** Cancel any pending or active settle cycle. Idempotent. */
  stop(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
