/**
 * @module autoclose-config
 * @category Internal
 *
 * Defaults, Zod schema, and resolver for the autoclose knobs on
 * {@link ActOptions} (#837 / epic #802). Split out of `act.ts` so the
 * orchestrator file stays focused on the `Act` class and the
 * autoclose surface lives with the cycle + controller that consume
 * it. The validation pattern matches the rest of the framework —
 * Zod schema with `.min().max().default(...)` per field — so the
 * upcoming policy-factory subs (#838 retention, #839 terminal,
 * #840 cardinality) can `.extend(...)` it for their own
 * per-policy options without reinventing range checks.
 *
 * @internal
 */

import { z } from "zod";
import type { ActOptions } from "../act.js";

/**
 * Default {@link ActOptions.autocloseCycleMs}: 60 s. Sized for typical
 * business-app close cadences (close-when-resolved on tickets,
 * close-when-stale on sessions) where same-second response is not the
 * goal. Operators with tighter requirements override; the floor is
 * 10 s (any tighter is the wrong primitive).
 */
export const DEFAULT_AUTOCLOSE_CYCLE_MS = 60_000;

/**
 * Default {@link ActOptions.closeBatchSize}: 64. Bounds the
 * `Store.query_streams` page size + the truncate fan-out per cycle
 * tick so a "close everything" misconfiguration can't take down the
 * writer.
 */
export const DEFAULT_CLOSE_BATCH_SIZE = 64;

/**
 * Default {@link ActOptions.closeYieldMs}: 0. The cycle yields a
 * microtask between truncates by default; SQLite operators set a
 * positive value to release the writer lock.
 */
export const DEFAULT_CLOSE_YIELD_MS = 0;

/**
 * Zod schema for the autoclose knobs on {@link ActOptions}. Same
 * declarative-validation pattern the framework uses elsewhere
 * (`libs/act/src/config.ts`, every event/action schema, every
 * reaction-option shape). Defaults, ranges, and integer constraints
 * live in one place — no parallel `DEFAULT_*` + `*_MIN` / `*_MAX`
 * declarations to keep in sync. Out-of-range values throw `ZodError`
 * at `act().build()` so misconfiguration surfaces at startup, not
 * on the first cycle tick.
 *
 * @internal
 */
const AutoCloseSchema = z.object({
  autocloseCycleMs: z
    .number()
    .min(10_000)
    .max(3_600_000)
    .default(DEFAULT_AUTOCLOSE_CYCLE_MS),
  closeBatchSize: z
    .number()
    .int()
    .min(1)
    .max(1024)
    .default(DEFAULT_CLOSE_BATCH_SIZE),
  closeYieldMs: z.number().min(0).max(1000).default(DEFAULT_CLOSE_YIELD_MS),
  closeOnError: z.boolean().default(false),
});

/**
 * Resolved autoclose configuration after validation and default
 * expansion. Internal — the orchestrator's autoclose controller
 * runs against this shape. Fields are snake_case per the internal
 * type-field convention; {@link resolve_autoclose_config} does the
 * camelCase→snake_case mapping from the public `ActOptions` shape.
 *
 * @internal
 */
export type AutoCloseConfig = {
  readonly cycle_ms: number;
  readonly batch_size: number;
  readonly yield_ms: number;
  readonly close_on_error: boolean;
};

/**
 * Validate and apply defaults for the autoclose knobs on
 * {@link ActOptions}. Called from `act().build()`. Out-of-range
 * values throw at startup, not on the first cycle tick.
 *
 * @internal
 */
export function resolve_autoclose_config(
  options: ActOptions | undefined
): AutoCloseConfig {
  const parsed = AutoCloseSchema.parse({
    autocloseCycleMs: options?.autocloseCycleMs,
    closeBatchSize: options?.closeBatchSize,
    closeYieldMs: options?.closeYieldMs,
    closeOnError: options?.closeOnError,
  });
  return {
    cycle_ms: parsed.autocloseCycleMs,
    batch_size: parsed.closeBatchSize,
    yield_ms: parsed.closeYieldMs,
    close_on_error: parsed.closeOnError,
  };
}
