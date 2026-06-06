/**
 * @module drain-ratio
 * @category Internal
 *
 * Adaptive lag-to-lead ratio for the dual-frontier drain strategy.
 *
 * The orchestrator splits its per-cycle stream budget between two frontiers:
 *
 * - **lagging** — newly subscribed or behind streams catching up.
 * - **leading** — actively-processing streams at the head of the log.
 *
 * After each cycle, this helper looks at how many events were actually
 * handled in each frontier and shifts the next cycle's split toward
 * whichever frontier had the higher per-stream throughput. The result is
 * clamped to `[0.2, 0.8]` so neither frontier can be starved.
 *
 * @internal
 */

import type { HandleResult } from "./drain-cycle.js";

/** Floor / ceiling for the lag-to-lead ratio so neither frontier starves. */
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;
/** Default ratio when no events were handled in either frontier. */
const RATIO_DEFAULT = 0.5;

/**
 * Compute the next lag-to-lead ratio from the cycle's handled events and
 * the frontier sizes used to claim them. Returns `RATIO_DEFAULT` when no
 * progress was made (nothing to base a decision on).
 */
export function compute_lag_lead_ratio(
  handled: ReadonlyArray<HandleResult>,
  lagging: number,
  leading: number
): number {
  let lagging_handled = 0;
  let leading_handled = 0;
  for (const { lease, handled: count } of handled) {
    if (lease.lagging) lagging_handled += count;
    else leading_handled += count;
  }
  const lagging_avg = lagging > 0 ? lagging_handled / lagging : 0;
  const leading_avg = leading > 0 ? leading_handled / leading : 0;
  const total = lagging_avg + leading_avg;
  if (total === 0) return RATIO_DEFAULT;
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, lagging_avg / total));
}
