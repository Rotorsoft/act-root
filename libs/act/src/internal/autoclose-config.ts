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
 * Default {@link ActOptions.autocloseCycleMinutes}: 720 (12 h).
 *
 * @deprecated The knob it defaults is deprecated (#1175) — the
 * off-window re-check is derived from `autocloseWindow` via
 * {@link next_window_open}, so nothing consumes the cadence. Kept so
 * existing imports and the compat validation keep working; removed in
 * the next major.
 */
export const DEFAULT_AUTOCLOSE_CYCLE_MINUTES = 720;

/**
 * Default {@link ActOptions.closeBatchSize}: 64.
 *
 * @deprecated Dead since #1090 removed the autoclose sweep — nothing
 * pages the store in batches. Kept for compat; removed in the next
 * major.
 */
export const DEFAULT_CLOSE_BATCH_SIZE = 64;

/**
 * Default {@link ActOptions.closeYieldMs}: 0.
 *
 * @deprecated Dead since #1090 removed the autoclose sweep — there is
 * no truncate loop to yield between. Kept for compat; removed in the
 * next major.
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
  autocloseCycleMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(DEFAULT_AUTOCLOSE_CYCLE_MINUTES),
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
    autocloseCycleMinutes: options?.autocloseCycleMinutes,
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

/**
 * The next instant the off-hours window opens at or after `now`. The
 * synthesized autoclose reaction defers to this when a tick lands
 * outside the window — parking until the window actually opens instead
 * of blind-polling on a configured cadence (the pre-#1175 behavior,
 * where a poll interval longer than the window could oscillate around
 * it and miss it repeatedly).
 *
 * Walks forward hour by hour and asks `Intl` for the local hour at each
 * step, so DST transitions resolve exactly the way the runtime's zone
 * database says they do — a 23- or 25-hour day never desynchronizes the
 * walk. The window validates as non-empty at build, and every zone hits
 * each `[0, 23]` hour label within any 48-hour span, so the walk always
 * terminates; the bound is a defensive backstop, with "one day out" as
 * the fallback no real zone can reach.
 *
 * Minute/second offsets within the opening hour are preserved from
 * `now` shifted by whole hours — the contract is hour-granular, matching
 * the window's own `[start, end)` hour semantics.
 *
 * @internal
 */
export function next_window_open(
  window: NonNullable<AutocloseConfig["autocloseWindow"]>,
  now: Date
): Date {
  for (let h = 0; h <= 48; h++) {
    const candidate = new Date(now.getTime() + h * 3_600_000);
    if (hour_in_zone(candidate, window.timeZone) === window.start)
      return candidate;
  }
  return new Date(now.getTime() + 86_400_000);
}
