/**
 * @module defer-timer
 * @category Internal
 *
 * The shared "next visit time" primitive (#1090). A `DeferTimer` holds a
 * `stream → due-time` map and a single collapsed wake timer: it parks
 * streams that should be re-visited later and fires one `on_wake` callback
 * at the earliest pending due-time, garbage-collecting the entries that have
 * come due.
 *
 * Two consumers ride it:
 *
 * - the {@link "drain-cycle".DrainController} — for per-reaction backoff (a
 *   retry's `next_attempt_at`) and, once handlers can express it, the
 *   `defer` outcome that holds a stream pending without advancing the
 *   watermark or bumping `retry`.
 * - the autoclose controller — to schedule its next eligibility check at the
 *   precise time an `after`-style cooldown elapses, instead of a blind
 *   fixed-interval sweep.
 *
 * Lives in process memory, per worker — the same per-worker pacing trade-off
 * documented for backoff. Durability comes from the data the due-time is
 * *derived* from (an un-advanced watermark, an event's `created` timestamp),
 * not from the map: a restart rebuilds it from the log.
 *
 * @internal
 */

/**
 * A min-heap-free scheduler over a small `stream → due-time` map. The maps
 * are bounded by the worker's claim/stream limits, so a linear scan for the
 * earliest entry is cheaper than maintaining a heap.
 *
 * @internal
 */
export class DeferTimer {
  private readonly _due = new Map<string, number>();
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private readonly _on_wake: () => void;

  /**
   * @param on_wake - invoked once each time the earliest due-time elapses,
   *   after the come-due entries have been removed. Consumers use it to
   *   re-arm their loop (the drain sets its `armed` flag; autoclose runs a
   *   tick).
   */
  constructor(on_wake: () => void) {
    this._on_wake = on_wake;
  }

  /** Number of currently parked streams. */
  get size(): number {
    return this._due.size;
  }

  /**
   * True while `stream` is parked with a due-time still in the future.
   * Consumers skip work for deferred streams until their window elapses.
   */
  is_deferred = (stream: string): boolean => {
    const next = this._due.get(stream);
    return next !== undefined && next > Date.now();
  };

  /**
   * Park `stream` for a re-visit at `at` (ms since epoch). A plain
   * overwrite: the caller computes the authoritative next-visit for the
   * stream (the drain's `handle` already reconciles a stream's reactions
   * into one result per cycle), so there is no stale value to merge against.
   */
  set(stream: string, at: number): void {
    this._due.set(stream, at);
  }

  /** Drop `stream` from the parked set (e.g. on a successful ack or block). */
  delete(stream: string): void {
    this._due.delete(stream);
  }

  /**
   * (Re)schedule the wake timer at the earliest pending due-time. Idempotent
   * — collapses many parked streams into a single timer. A no-op clears any
   * pending timer when the map is empty.
   *
   * The timer is `unref()`-ed so pending re-visits never keep the process
   * alive on their own.
   */
  schedule(): void {
    if (this._timer) clearTimeout(this._timer);
    if (this._due.size === 0) {
      this._timer = undefined;
      return;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const t of this._due.values()) if (t < earliest) earliest = t;
    const delay = Math.max(0, earliest - Date.now());
    this._timer = setTimeout(() => {
      this._timer = undefined;
      // Garbage-collect the entries that have come due so the consumer's
      // next pass sees them as active again.
      const now = Date.now();
      for (const [stream, at] of this._due)
        if (at <= now) this._due.delete(stream);
      this._on_wake();
    }, delay);
    this._timer.unref();
  }

  /** Cancel any pending wake timer. Idempotent. Leaves the parked set intact. */
  stop(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
