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
 * Default {@link ActOptions.autocloseCycleMs}: 12 h. Autoclose is
 * low-urgency housekeeping — a stream eligible for close is "old"
 * (past a retention age) or "resolved a while ago" (terminal +
 * grace), never urgent — so the cycle runs a couple of times a day,
 * not as a hot path. Each run sweeps the whole store; the cadence is
 * how often that sweep repeats. Range is 1 minute to 24 hours; the
 * floor exists for window polling (see {@link ActOptions.autocloseWindow}),
 * the ceiling lets operators run it once a day.
 */
export const DEFAULT_AUTOCLOSE_CYCLE_MS = 43_200_000;

/**
 * Default {@link ActOptions.closeBatchSize}: 64. Bounds the per-batch
 * `query_stats` page size + the truncate fan-out within a run so a
 * full-store sweep streams through in bounded chunks instead of
 * materializing every candidate or truncating thousands at once.
 */
export const DEFAULT_CLOSE_BATCH_SIZE = 64;

/**
 * Default {@link ActOptions.closeYieldMs}: 0. The cycle yields a
 * microtask between truncates by default; SQLite operators set a
 * positive value to release the writer lock.
 */
export const DEFAULT_CLOSE_YIELD_MS = 0;

/**
 * Default time zone for {@link ActOptions.autocloseWindow} when the
 * operator declares a window without one. UTC keeps the contract
 * timezone-explicit; operators who think in local off-hours pass an
 * IANA name.
 */
export const DEFAULT_AUTOCLOSE_WINDOW_TZ = "UTC";

/**
 * True when `tz` is a time zone the runtime's `Intl` accepts. Used to
 * reject typos in {@link ActOptions.autocloseWindow} at build time.
 *
 * @internal
 */
function is_valid_time_zone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zod schema for the optional off-hours window. Hours are `[0, 23]`
 * integers; `start === end` is rejected because the half-open
 * `[start, end)` window it would describe is empty (and would silently
 * disable autoclose). `start > end` is allowed and means an overnight
 * window (e.g. `{ start: 22, end: 6 }` is 22:00 through 06:00).
 *
 * @internal
 */
const AutocloseWindowSchema = z
  .object({
    start: z
      .number()
      .int()
      .min(0)
      .max(23, { message: "autocloseWindow.start must be an hour in [0, 23]" }),
    end: z
      .number()
      .int()
      .min(0)
      .max(23, { message: "autocloseWindow.end must be an hour in [0, 23]" }),
    timeZone: z
      .string()
      .refine(is_valid_time_zone, {
        message: "autocloseWindow.timeZone must be a valid IANA time zone",
      })
      .default(DEFAULT_AUTOCLOSE_WINDOW_TZ),
  })
  .refine((w) => w.start !== w.end, {
    message:
      "autocloseWindow.start and end must differ — an empty window disables autoclose",
  });

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
const AutocloseOptionsSchema = z.object({
  autocloseCycleMs: z
    .number()
    .min(60_000)
    .max(86_400_000)
    .default(DEFAULT_AUTOCLOSE_CYCLE_MS),
  closeBatchSize: z
    .number()
    .int()
    .min(1)
    .max(1024)
    .default(DEFAULT_CLOSE_BATCH_SIZE),
  closeYieldMs: z.number().min(0).max(1000).default(DEFAULT_CLOSE_YIELD_MS),
  closeOnError: z.boolean().default(false),
  autocloseWindow: AutocloseWindowSchema.optional(),
});

/**
 * Resolved autoclose configuration after validation and default
 * expansion. Reachable through the public root (`@rotorsoft/act`) so
 * fields follow the public-camelCase convention and mirror the
 * `ActOptions` knob names directly — no per-resolver renaming layer.
 */
export type AutocloseConfig = z.infer<typeof AutocloseOptionsSchema>;

/**
 * Validate and apply defaults for the autoclose knobs on
 * {@link ActOptions}. Called from `act().build()`. Out-of-range
 * values throw `ZodError` at startup, not on the first cycle tick.
 */
export function resolveAutocloseConfig(
  options: ActOptions | undefined
): AutocloseConfig {
  return AutocloseOptionsSchema.parse({
    autocloseCycleMs: options?.autocloseCycleMs,
    closeBatchSize: options?.closeBatchSize,
    closeYieldMs: options?.closeYieldMs,
    closeOnError: options?.closeOnError,
    autocloseWindow: options?.autocloseWindow,
  });
}

/**
 * The current hour `[0, 23]` in the given IANA time zone, DST-correct
 * via `Intl`. Split out so the window check can be unit-tested without
 * spinning a controller.
 *
 * @internal
 */
export function hour_in_zone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value);
}

/**
 * Whether `now` falls inside the configured off-hours window. The
 * window is half-open on hour boundaries — `[start, end)` — and wraps
 * past midnight when `start > end`. With no window configured every
 * tick runs, so callers treat `undefined` as "always in window."
 *
 * @internal
 */
export function in_autoclose_window(
  window: AutocloseConfig["autocloseWindow"],
  now: Date
): boolean {
  if (!window) return true;
  const hour = hour_in_zone(now, window.timeZone);
  return window.start < window.end
    ? hour >= window.start && hour < window.end
    : hour >= window.start || hour < window.end;
}
