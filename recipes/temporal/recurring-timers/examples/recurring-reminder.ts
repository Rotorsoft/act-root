/**
 * Recurring timer as a composition of shipped primitives (no `every` form).
 *
 * A recurring reaction is just a one-shot `.defer(when)` that, when it fires,
 * emits the *next* tick and acks the current one. Because each tick is a real
 * committed event, the watermark advances every cycle and the stream keeps
 * moving — the opposite of holding a single event forever. A payload counter
 * bounds it, and a terminal event lets `.autocloses` reap the per-entity timer
 * stream once the flow is done, so a resolved reminder loop doesn't sit in
 * primary storage forever.
 *
 * The `schedule` is a parameter so the same aggregate serves every cadence:
 * pass `{ after: { hours: 24 } }` for a daily nudge, or a function of the tick
 * event for a widening backoff (see the sibling scenarios in the README).
 *
 * Run:  pnpm tsx recipes/temporal/recurring-timers/examples/recurring-reminder.ts
 */

import {
  act,
  type Committed,
  type DeferWhen,
  state,
  ZodEmpty,
} from "@rotorsoft/act";
import { z } from "zod";

const SYS = { id: "system", name: "reminder-timer" };

/** The tick event carries the attempt number so a backoff can widen on it. */
const RemindedShape = { Reminded: z.object({ nth: z.number() }) };

/** The Reminders event map, for typing the schedule function's event arg. */
type ReminderEvents = {
  Reminded: { nth: number };
  RemindersEnded: Record<string, never>;
};

/**
 * A per-entity timer aggregate. Streams are keyed per subject (e.g.
 * `reminders:ticket-42`). `Reminded` is the recurring tick; `RemindersEnded`
 * is the terminal event the reaper keys on.
 */
export const Reminders = state({
  Reminders: z.object({ sent: z.number(), ended: z.boolean() }),
})
  .init(() => ({ sent: 0, ended: false }))
  .emits({ ...RemindedShape, RemindersEnded: ZodEmpty })
  .patch({
    Reminded: (e) => ({ sent: e.data.nth }),
    RemindersEnded: () => ({ ended: true }),
  })
  .on({ remind: z.object({ nth: z.number() }) })
  .emit((a) => ["Reminded", a])
  .on({ endReminders: ZodEmpty })
  .emit(() => ["RemindersEnded", {}])
  // Reap the timer stream once the loop ends: `.autocloses` closes it the
  // moment the head is the terminal event, so a resolved reminder loop is
  // truncated (and, with `.archives`, cold-tiered) instead of lingering.
  .autocloses({ is: "RemindersEnded" })
  .build();

/** A cadence: a fixed `DeferWhen`, or one derived from the tick event. */
export type ReminderSchedule =
  | DeferWhen
  | ((event: Committed<ReminderEvents, "Reminded">) => DeferWhen);

/**
 * Build a reminder-timer app. `stop` decides, on each tick, whether the loop is
 * done (in a real app this loads domain state — "is the ticket resolved?"); the
 * default bounds it at `max` ticks. `onRemind` is the side effect (send the
 * nudge). Route the reaction onto its own per-entity target with `.to(...)` in
 * production so the timer never holds the subject's other reactions.
 */
export function buildReminderTimer(opts: {
  schedule: ReminderSchedule;
  max: number;
  onRemind?: (nth: number) => void | Promise<void>;
}) {
  return act()
    .withState(Reminders)
    .on("Reminded")
    .defer(opts.schedule)
    .do(async function nudge(event, stream, app) {
      if (event.data.nth >= opts.max) {
        await app.do("endReminders", { stream, actor: SYS }, {});
        return;
      }
      await opts.onRemind?.(event.data.nth);
      await app.do(
        "remind",
        { stream, actor: SYS },
        { nth: event.data.nth + 1 }
      );
    })
    .build();
}

/** Seed the first tick for a subject; the reaction re-arms from there. */
export async function startReminders(
  app: ReturnType<typeof buildReminderTimer>,
  subject: string
) {
  await app.do(
    "remind",
    { stream: `reminders:${subject}`, actor: SYS },
    { nth: 1 }
  );
}
