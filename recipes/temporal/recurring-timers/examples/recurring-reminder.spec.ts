import { type CloseResult, dispose, sleep } from "@rotorsoft/act";
import { afterEach, describe, expect, it } from "vitest";
import { buildReminderTimer, startReminders } from "./recurring-reminder.js";

/**
 * Unit test for the recurring-timer recipe. Uses a sub-second cadence (the
 * `(event) => { at }` form) so the loop is driven with plain waits, the way the
 * framework's `defer-outcome.spec` drives a single defer.
 */
describe("recurring reminder timer recipe", () => {
  const STEP = 40; // ms between ticks

  afterEach(async () => {
    await dispose()();
  });

  it("re-fires on a cadence, advances the stream, and ends on the bound", async () => {
    const sent: number[] = [];
    const app = buildReminderTimer({
      schedule: (event) => ({ at: new Date(event.created.getTime() + STEP) }),
      max: 3,
      onRemind: (nth) => {
        sent.push(nth);
      },
    });

    await startReminders(app, "t1");
    for (let i = 0; i < 8; i++) {
      await app.correlate();
      await app.drain({ leaseMillis: 1 });
      await sleep(STEP + 20);
    }

    // The nudge side effect is the autoclose-independent evidence of the loop:
    // ticks 1 and 2 fired a nudge and re-armed; tick 3 hit the bound and ended
    // instead. Reaching tick 3 (not stalling at tick 1) is the proof the
    // watermark advanced every cycle rather than pinning one held event.
    expect(sent).toEqual([1, 2]);
  });

  it("autocloses (reaps) the timer stream once the loop ends", async () => {
    const closed: CloseResult[] = [];
    const app = buildReminderTimer({
      schedule: (event) => ({ at: new Date(event.created.getTime() + STEP) }),
      max: 2,
    });
    app.on("closed", (r) => closed.push(r));

    await startReminders(app, "t2");
    for (let i = 0; i < 8; i++) {
      await app.correlate();
      await app.drain({ leaseMillis: 1 });
      await sleep(STEP + 20);
    }

    // The `.autocloses({ is: "RemindersEnded" })` policy reaps the per-entity
    // stream the moment its head is the terminal event.
    expect(closed.some((r) => r.truncated.has("reminders:t2"))).toBe(true);
  });
});
