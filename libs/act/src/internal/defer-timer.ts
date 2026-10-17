/**
 * The shared "next visit time" primitive. A `DeferTimer` holds a
 * `stream → due-time` map and a single collapsed wake timer: it parks
 * streams that should be re-visited later and fires one `on_wake` callback
 * at the earliest pending due-time.
 *
 * The {@link "drain-cycle".DrainController} rides it for per-reaction
 * backoff (a retry's `next_attempt_at`) and for the `defer` outcome, which
 * holds a stream pending without advancing the watermark or bumping `retry`.
 * The wake runs a drain, and the drain re-schedules the timer when it ends.
 * An entry stays until its stream is acked or blocked, re-parked, or a
 * drain that started after it came due claims nothing ({@link prune}): a
 * wake that lands during another drain, or a pass that reaches only some of
 * the due streams, leaves the rest due, so the next re-schedule fires again
 * at once.
 *
 * Lives in process memory, per worker — the same per-worker pacing trade-off
 * documented for backoff. Durability comes from the data the due-time is
 * *derived* from (an un-advanced watermark, an event's `created` timestamp),
 * not from the map. A restart empties the map, so the cold-start rebuild is
 * explicit: `CorrelateCycle.init` seeds each still-future `deferred_at` back
 * onto the owning lane's timer via {@link "drain-cycle".DrainController.seed_defer},
 * so an idle deferred stream re-arms at its due-time with no
 * intervening commit.
 */

/**
 * Node's `setTimeout` delay is a 32-bit signed int (~24.8 days). A larger
 * delay overflows and fires immediately, so we cap at this and re-arm.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A linear scan finds the earliest entry: the map is bounded by claim limits. */
export class DeferTimer {
  private readonly _due = new Map<string, number>();
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private readonly _on_wake: () => void;

  /**
   * @param on_wake - invoked once each time the earliest due-time elapses.
   *   The consumer re-schedules for whatever is still parked.
   */
  constructor(on_wake: () => void) {
    this._on_wake = on_wake;
  }

  /** Number of currently parked streams. */
  get size(): number {
    return this._due.size;
  }

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
   * Drop every entry due at or before `before`. The drain calls it when a
   * pass that started at `before` claimed nothing: whatever was due by then
   * was handled elsewhere (another worker) or has no work left, so waking
   * for it again would spin.
   */
  prune(before: number): void {
    for (const [stream, at] of this._due)
      if (at <= before) this._due.delete(stream);
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
    // A longer due-time (a 90-day autoclose cooldown) wakes at the ceiling;
    // the entry stays and the consumer re-schedules for the rest.
    const delay = Math.min(
      Math.max(0, earliest - Date.now()),
      MAX_TIMER_DELAY_MS
    );
    this._timer = setTimeout(() => {
      this._timer = undefined;
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
