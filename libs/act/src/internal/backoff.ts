/**
 * @module backoff
 * @category Internal
 *
 * Per-reaction retry backoff delay computation. Pure function — keeps
 * `DrainController` and `reactions._finalize` testable in isolation.
 *
 * @internal
 */

import type { BackoffOptions } from "../types/action.js";

// The `BackoffOptions` config schema + resolver live in `./config.ts` (the
// single home for every builder-facing config bag). This module keeps only
// the runtime delay math, which stays hot-path and dependency-free.

/**
 * Compute the wall-clock delay (in ms) to wait before the next attempt on
 * a stream whose handler just failed.
 *
 * @param retry - The lease's `retry` counter at finalize time. `0` is the
 *   first attempt that failed; `1` is after one retry; etc.
 * @param opts - Per-reaction backoff config. Returns `0` when undefined.
 * @returns Non-negative integer milliseconds. Always `0` when `opts` is
 *   undefined or `baseMs <= 0`.
 */
export function compute_backoff_delay(
  retry: number,
  opts: BackoffOptions | undefined
): number {
  if (!opts || opts.baseMs <= 0) return 0;
  const r = Math.max(0, retry);
  let delay: number;
  switch (opts.strategy) {
    case "fixed":
      delay = opts.baseMs;
      break;
    case "linear":
      delay = opts.baseMs * (r + 1);
      break;
    case "exponential":
      delay = opts.baseMs * 2 ** r;
      if (opts.maxMs !== undefined) delay = Math.min(delay, opts.maxMs);
      break;
    default: {
      // Unreachable once options pass `resolveBackoffConfig` at their
      // declaration site. Defensive so the pure function is total and can
      // never emit `NaN` from an unvalidated strategy — throw instead.
      const _never: never = opts.strategy;
      throw new Error(`unknown backoff strategy: ${String(_never)}`);
    }
  }
  if (opts.jitter) delay = delay * (0.5 + Math.random());
  return Math.max(0, Math.floor(delay));
}
