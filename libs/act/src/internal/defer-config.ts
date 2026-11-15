/**
 * The `when` options for the public `defer` surface. A
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
 * The `when` bag's schema lives in `internal/config.ts`, checked with
 * `check("defer", when)`.
 */

import { DeferSignal } from "../types/errors.js";
import type { Committed, DeferWhen, Schemas } from "../types/index.js";
import { check } from "./config.js";

/** Sum a duration bag to milliseconds. */
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
 * triggering event. Checks the `defer` bag (throws `ZodError` on a bad
 * shape), then derives the time: `after` from `event.created`, `at`
 * from its absolute `Date`. Never reads `Date.now()`, so the result is stable
 * across re-delivery.
 */
export function resolve_defer_at<E extends Schemas>(
  when: DeferWhen,
  event: Committed<E, keyof E>
): number {
  const parsed = check("defer", when);
  if (parsed.after) return event.created.getTime() + duration_ms(parsed.after);
  return parsed.at!.getTime();
}

/**
 * The schedule handed to the declarative `.defer` builder step: either a
 * literal {@link DeferWhen} (fixed cooldown/deadline) or a function of the
 * triggering event (read the payload to choose the schedule).
 */
export type DeferSchedule<TEvent> = DeferWhen | ((event: TEvent) => DeferWhen);

/**
 * Wrap a reaction handler so it holds until its schedule is due, then runs.
 * On each delivery it resolves the schedule against the triggering event; if
 * the due-time hasn't arrived it throws {@link DeferSignal} (the drain holds
 * the stream, no watermark advance, no retry bump), otherwise it runs the
 * real handler. The wrapper keeps the original handler's `name` so reaction
 * registration and de-dup are unaffected, and preserves the handler's exact
 * type so the builder step is transparent.
 */
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
