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
import { DeferSignal } from "./defer-signal.js";

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
 * Zod schema for the `defer(when)` options bag. Exactly one of `after` / `at`;
 * `at` is an absolute `Date`. Internal per the config standard; the public
 * surface is {@link DeferWhen} and {@link resolve_defer_at}.
 *
 * @internal
 */
const DeferWhenSchema = z
  .object({
    after: DeferDurationSchema.optional(),
    at: z.date().optional(),
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
 * from its absolute `Date`. Never reads `Date.now()`, so the result is stable
 * across re-delivery.
 *
 * @internal
 */
export function resolve_defer_at<E extends Schemas>(
  when: DeferWhen,
  event: Committed<E, keyof E>
): number {
  const parsed = DeferWhenSchema.parse(when);
  if (parsed.after) return event.created.getTime() + duration_ms(parsed.after);
  return parsed.at!.getTime();
}

/**
 * The schedule handed to the declarative `.defer` builder step: either a
 * literal {@link DeferWhen} (fixed cooldown/deadline) or a function of the
 * triggering event (read the payload to choose the schedule).
 *
 * @internal
 */
export type DeferSchedule<TEvent> = DeferWhen | ((event: TEvent) => DeferWhen);

/**
 * Validate a literal `when` at build time (fail fast, per the config-schema
 * standard) — throws `ZodError` on a bad shape (both/neither of `after`/`at`,
 * an empty or non-positive duration). The function form of a `.defer` schedule
 * can only be checked when it runs, so builders pass just the literal here.
 *
 * @internal
 */
export function assert_defer_when(when: DeferWhen): void {
  DeferWhenSchema.parse(when);
}

/**
 * Wrap a reaction handler so it holds until its schedule is due, then runs.
 * On each delivery it resolves the schedule against the triggering event; if
 * the due-time hasn't arrived it throws {@link DeferSignal} (the drain holds
 * the stream, no watermark advance, no retry bump), otherwise it runs the
 * real handler. The wrapper keeps the original handler's `name` so reaction
 * registration and de-dup are unaffected, and preserves the handler's exact
 * type so the builder step is transparent.
 *
 * @internal
 */
// biome-ignore lint/suspicious/noExplicitAny: preserve the caller's exact
// handler signature so the builder step is type-transparent.
export function make_deferred<H extends (...args: any[]) => Promise<unknown>>(
  handler: H,
  schedule: DeferSchedule<Parameters<H>[0]>
): H {
  const call = handler as (...args: unknown[]) => Promise<unknown>;
  const deferred = async (
    event: Parameters<H>[0],
    stream: string,
    app: unknown
  ) => {
    const when = typeof schedule === "function" ? schedule(event) : schedule;
    if (Date.now() < resolve_defer_at(when, event)) throw new DeferSignal(when);
    return call(event, stream, app);
  };
  Object.defineProperty(deferred, "name", { value: handler.name });
  return deferred as unknown as H;
}
