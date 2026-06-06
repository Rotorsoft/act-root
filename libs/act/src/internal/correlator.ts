/**
 * @module correlator
 * @category Internal
 *
 * Correlation-id generator and the default implementation (ACT-404).
 *
 * The default produces a readable, time-monotonic-within-window, lowercase
 * id like `coun-incr-lwxk9p3a` — short enough to scan in logs, structured
 * enough to identify the originating state/action, and well-distributed
 * enough that competing-consumer workers don't collide.
 *
 * Apps override via {@link ActOptions.correlator} to plug in any scheme
 * (tenant-prefixed, trace-id-propagated, DB-sequence-backed, etc.).
 *
 * @internal
 */

import { randomInt } from "node:crypto";
import type { Actor, Correlator } from "../types/index.js";

const BASE = 36;
const SEG_WIDTH = 4;
const SEG_SPACE = BASE ** SEG_WIDTH;

function seg(n: number): string {
  return n.toString(BASE).padStart(SEG_WIDTH, "0");
}

/**
 * Default {@link Correlator}. Produces ids of the form
 * `{state[:4]}-{action[:4]}-{4 ms}{4 random}` — 18 characters, lowercase
 * base36.
 *
 * - Prefix carries human-meaningful context (state + action) so operators
 *   can identify a workflow at a glance in logs and query results.
 * - The 4-character `Date.now() % 36^4` segment wraps every ~28 minutes,
 *   long enough that adjacent inserts in a typical workflow share B-tree
 *   pages — index locality, not global sortability, is the goal.
 * - The 4-character random tail gives 1.68M values per ms; collision risk
 *   across K=100 concurrent workers is roughly K² / 3.4M per ms.
 *
 * Names shorter than 4 chars are used as-is (no padding) so a state named
 * `Tx` produces `tx-...` rather than `tx00-...`.
 */
export const default_correlator: Correlator = ({ state, action }) => {
  const s = state.slice(0, SEG_WIDTH).toLowerCase();
  const a = action.slice(0, SEG_WIDTH).toLowerCase();
  const ts = seg(Date.now() % SEG_SPACE);
  const rnd = seg(randomInt(SEG_SPACE));
  return `${s}-${a}-${ts}${rnd}`;
};

/**
 * Resolves the correlation id for the close-the-books transaction.
 * Close runs outside any user action, so we synthesize a context with
 * sentinel state/action names — visible in the id when overrides aren't
 * configured.
 *
 * @internal
 */
export function close_correlation(
  correlator: Correlator,
  actor: Actor
): string {
  return correlator({
    state: "$close",
    action: "close",
    stream: "$close",
    actor,
  });
}
