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
 * not from the map. A restart empties the map, so the cold-start rebuild is
 * explicit: `CorrelateCycle.init` seeds each still-future `deferred_at` back
 * onto the owning lane's timer via {@link "drain-cycle".DrainController.seed_defer}
 * (#1221), so an idle deferred stream re-arms at its due-time with no
 * intervening commit.
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

/**
 * Node's `setTimeout` delay is a 32-bit signed int (~24.8 days). A larger
 * delay overflows and fires immediately, so we cap at this and re-arm.
 *
 * @internal
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
    // Clamp to setTimeout's 32-bit ceiling (~24.8 days). A longer due-time
    // (e.g. a 90-day autoclose cooldown) would otherwise overflow and Node
    // fires it immediately, busy-looping. Instead we wake at the ceiling and
    // re-arm: the GC below keeps the still-future entry, `on_wake` re-schedules
    // for the remaining span, and (for persisted defers) `claim` skips the
    // stream until its real due-time anyway.
    const delay = Math.min(
      Math.max(0, earliest - Date.now()),
      MAX_TIMER_DELAY_MS
    );
    this._timer = setTimeout(() => {
      this._timer = undefined;
      // Garbage-collect the entries that have come due so the consumer's
      // next pass sees them as active again.
      const now = Date.now();
      let came_due = false;
      for (const [stream, at] of this._due)
        if (at <= now) {
          this._due.delete(stream);
          came_due = true;
        }
      this._on_wake();
      // Premature ceiling clamp: nothing came due, yet entries remain — the
      // earliest due-time was past the 32-bit `setTimeout` ceiling, so this
      // wake fired early. The consumer's `on_wake` won't re-arm (the drain's
      // just sets its armed flag, and its next pass early-returns while the
      // stream is still store-excluded), so the primitive must self-re-arm or
      // a >ceiling defer/cooldown loses its precise wake (#1288). A normal wake
      // (something came due) leaves re-arming to the consumer, preserving the
      // fire-once-per-schedule model.
      if (!came_due && this._due.size > 0) this.schedule();
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
