/**
 * @module defer-config
 * @category Internal
 *
 * The `when` options for the public `defer` surface (#1091, RFC 0001). A
 * reaction defers itself to a future time either declaratively (the
 * `.defer(when)` builder step) or imperatively (`throw new DeferSignal(when)`
 * inside a handler); both resolve `when` through here.
 *
 * The load-bearing rule is **derivability**. A deferred stream's due-time must
 * be recomputable by whichever worker re-claims it after the wait, so `when`
 * never resolves against `Date.now()`. `after` is measured from the triggering
 * event's `created` timestamp, and `at` is either a fixed `Date` or a pure
 * function of the event. Either way, re-delivering the same event yields the
 * same due-time, which is what makes a defer correct across restarts and
 * competing workers.
 *
 * Validation follows the config-schema standard (CLAUDE.md): an internal
 * `*OptionsSchema` const, a public inferred type, and a resolver. Slice 2
 * ships `after` / `at`; recurrence (`every`) extends this in Slice 3 (#1092).
 *
 * @internal
 */

import { z } from "zod";
import type { Committed, DeferWhen, Schemas } from "../types/index.js";

/**
 * A relative span, measured from the triggering event's `created` time. At
 * least one field is required; fields are additive (`{ hours: 1, minutes: 30 }`
 * is 90 minutes).
 */
const DeferDurationSchema = z
  .object({
    days: z.number().positive().optional(),
    hours: z.number().positive().optional(),
    minutes: z.number().positive().optional(),
  })
  .strict()
  .refine((d) => d.days != null || d.hours != null || d.minutes != null, {
    message: "defer: a duration needs at least one of days, hours, or minutes",
  });

/**
 * Zod schema for the `defer(when)` options bag. Exactly one of `after` / `at`.
 * `at` is a `Date` or a function of the event (checked structurally, since a
 * function can't be introspected further). Internal per the config standard;
 * the public surface is {@link DeferWhen} and {@link resolve_defer_at}.
 *
 * @internal
 */
const DeferWhenSchema = z
  .object({
    after: DeferDurationSchema.optional(),
    at: z
      .union([
        z.date(),
        z.custom<(event: Committed<Schemas, string>) => Date>(
          (v) => typeof v === "function"
        ),
      ])
      .optional(),
  })
  .strict()
  .refine((w) => (w.after === undefined) !== (w.at === undefined), {
    message: "defer: specify exactly one of `after` or `at`",
  });

/** Sum a duration bag to milliseconds. @internal */
function duration_ms(d: {
  days?: number;
  hours?: number;
  minutes?: number;
}): number {
  return (
    (d.days ?? 0) * 86_400_000 +
    (d.hours ?? 0) * 3_600_000 +
    (d.minutes ?? 0) * 60_000
  );
}

/**
 * Resolve `when` to an absolute due-time (ms since epoch) for a given
 * triggering event. Validates via {@link DeferWhenSchema} (throws `ZodError`
 * on a bad shape), then derives the time: `after` from `event.created`, `at`
 * from the `Date` or from calling its function with the event. Never reads
 * `Date.now()`, so the result is stable across re-delivery.
 *
 * @internal
 */
export function resolve_defer_at<E extends Schemas>(
  when: DeferWhen<Committed<E, keyof E>>,
  event: Committed<E, keyof E>
): number {
  const parsed = DeferWhenSchema.parse(when);
  if (parsed.after) return event.created.getTime() + duration_ms(parsed.after);
  const at = parsed.at!;
  const date =
    typeof at === "function"
      ? (at as (e: Committed<E, keyof E>) => Date)(event)
      : at;
  return date.getTime();
}
