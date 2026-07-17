/**
 * @module backoff
 * @category Internal
 *
 * Per-reaction retry backoff delay computation. Pure function — keeps
 * `DrainController` and `reactions._finalize` testable in isolation.
 *
 * @internal
 */

import { z } from "zod";
import type { BackoffOptions } from "../types/action.js";

/**
 * Config-validation schema for {@link BackoffOptions} (ACT-1269). Follows the
 * config-schema standard: internal const, never re-exported. Rejects an
 * off-union `strategy`, a non-finite/negative `baseMs`, or a non-finite/
 * non-positive `maxMs` at the declaration site — so a typo or a `NaN` from
 * JSON/env config surfaces as a `ZodError` at `act().build()` instead of
 * silently producing a `NaN` delay that disables pacing on the first retry.
 *
 * No `maxMs >= baseMs` constraint: `maxMs` is a cap, and `exponential`
 * clamping to a sub-`baseMs` cap is documented behavior, not an error.
 * @internal
 */
const BackoffOptionsSchema = z.object({
  // z.number() rejects NaN/±Infinity by default in Zod 4, so `.min(0)` /
  // `.gt(0)` also close the non-finite gap.
  strategy: z.enum(["fixed", "linear", "exponential"]),
  baseMs: z.number().min(0),
  maxMs: z.number().gt(0).optional(),
  jitter: z.boolean().optional(),
});

/**
 * Validate a backoff bag at its declaration site (reaction `.do(...)` /
 * action `.on(...)`). Passes `undefined` through untouched; otherwise parses
 * and returns the validated config, throwing `ZodError` on a bad value so
 * misconfiguration surfaces at build, not on the first cycle tick.
 * @internal
 */
export function resolveBackoffConfig(
  options: BackoffOptions | undefined
): BackoffOptions | undefined {
  return options === undefined
    ? undefined
    : BackoffOptionsSchema.parse(options);
}

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
