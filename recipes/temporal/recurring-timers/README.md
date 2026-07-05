# Recurring timers

You want a reaction to fire on a cadence. A daily nudge until the ticket is resolved, an escalation that backs off wider each time it goes unanswered, a bounded series of retries, a tick that lands every business morning. The framework ships one-shot deferral (`.defer(when)` and `throw new DeferSignal(when)`), and at first glance the missing piece looks like an `{ every }` schedule that would re-fire on its own. It is missing on purpose, and this recipe is the pattern that replaces it.

## The shape: a tick that emits the next tick

A recurring timer is a one-shot defer that, when it fires, does its work and then *emits the next tick* before it acks. Each tick is a real committed event, so the watermark advances every cycle and the stream keeps moving. That is the exact opposite of holding a single event forever. A counter on the tick payload (or a check against loaded domain state) bounds the loop, and a terminal event lets `.autocloses` reap the per-entity timer stream once the flow is done.

The runnable example in [`examples/recurring-reminder.ts`](examples/recurring-reminder.ts) is a small per-entity timer aggregate. `Reminded` is the recurring tick, carrying the attempt number so a schedule can widen on it; `RemindersEnded` is the terminal event the reaper keys on.

```ts
export const Reminders = state({
  Reminders: z.object({ sent: z.number(), ended: z.boolean() }),
})
  .init(() => ({ sent: 0, ended: false }))
  .emits({ Reminded: z.object({ nth: z.number() }), RemindersEnded: ZodEmpty })
  .patch({
    Reminded: (e) => ({ sent: e.data.nth }),
    RemindersEnded: () => ({ ended: true }),
  })
  .on({ remind: z.object({ nth: z.number() }) })
    .emit((a) => ["Reminded", a])
  .on({ endReminders: ZodEmpty })
    .emit(() => ["RemindersEnded", {}])
  .autocloses({ is: "RemindersEnded" })
  .build();
```

The reaction is the loop. It one-shot-defers the `Reminded` tick, decides whether the series is over, and if it is not, emits the next tick. The `schedule` is a parameter so the same aggregate serves every cadence.

```ts
act()
  .withState(Reminders)
  .on("Reminded")
    .defer(opts.schedule)
    .do(async function nudge(event, stream, app) {
      if (event.data.nth >= opts.max) {
        await app.do("endReminders", { stream, actor: SYS }, {});
        return;
      }
      await opts.onRemind?.(event.data.nth);
      await app.do("remind", { stream, actor: SYS }, { nth: event.data.nth + 1 });
    })
  .build();
```

Starting a series is a single seed commit; the reaction re-arms itself from there.

```ts
await app.do("remind", { stream: `reminders:${subject}`, actor: SYS }, { nth: 1 });
```

## Why there is no `{ every }`

The tempting primitive would be a schedule that re-delivers the *same* held event each interval. It was evaluated and rejected. A watermark is keyed by its target stream, and holding one event forever to re-fire it would pin that stream's watermark at the held event indefinitely. Every other reaction that drains the same stream would be parked behind a timer that never advances. The composition here has the opposite property: because each firing commits a fresh tick and acks the old one, the watermark moves every cycle and the stream stays live for everything else on it.

## Keep the timer off the subject's other reactions

Even with the watermark advancing, a timer that shares a stream with the subject's real work shares that stream's lease. Give the timer its own per-entity stream (the example keys streams `reminders:ticket-42`, distinct from `ticket-42`) so a reminder loop for a ticket never holds the ticket's own reactions. In production, route the reaction onto that per-entity target with `.to(...)`, and if the timer traffic is heavy enough to deserve its own budget, put it on its own lane with `.withLane({...})` so a slow nudge never competes with hot-path drains. Isolation is opt-in; the framework will not synthesize a separate stream behind your back.

## The scenarios

Each of these is the same factory with a different `schedule` and a different stop condition.

### Fixed cadence

A daily nudge that runs until the domain says the work is done. Set a constant span and, inside the handler, load the domain aggregate and stop when it reports resolved instead of relying on a fixed count.

```ts
buildReminderTimer({
  schedule: { after: { hours: 24 } },
  max: Infinity,
  onRemind: async (nth) => {
    // load domain state; if the ticket is resolved, endReminders instead of nudging
    await sendNudge(ticketId, nth);
  },
});
```

The stop condition is a property of the workflow, not the timer. A daily reminder that should end when the ticket closes reads that fact in the handler and emits the terminal event rather than the next tick.

### Widening backoff / escalation

The tick payload already carries the attempt number, so a schedule can widen the gap on every firing. This is the escalation shape: fifteen minutes, then thirty, then an hour, doubling each time.

```ts
buildReminderTimer({
  schedule: (event) => ({ after: { minutes: 15 * 2 ** event.data.nth } }),
  max: 6,
  onRemind: (nth) => escalate(nth),
});
```

The schedule is a pure function of the tick, so a worker that re-claims the stream mid-wait recomputes the same interval.

### Bounded count

Stop after a fixed number of ticks. The `max` bound in the factory is exactly this: when `nth` reaches the ceiling the handler emits `RemindersEnded` instead of the next tick.

```ts
buildReminderTimer({
  schedule: { after: { hours: 1 } },
  max: 3, // three nudges, then the series ends
  onRemind: (nth) => sendNudge(nth),
});
```

### Aligned / wall-clock cadence

When the cadence has to land on a wall-clock boundary rather than a span from the last tick (every business morning, the top of every hour, the first of the month), compute the next absolute `Date` and defer to it with `{ at }`. Derive it from the tick's own `created`, not from `Date.now()`.

```ts
buildReminderTimer({
  schedule: (event) => ({ at: nextBusinessMorning(event.created) }),
  max: Infinity,
  onRemind: (nth) => sendMorningDigest(nth),
});
```

### Reaping the stream

A finished loop should not sit in primary storage. The example's `.autocloses({ is: "RemindersEnded" })` closes the per-entity timer stream the moment its head is the terminal event, so a resolved reminder series is truncated instead of lingering. Pair it with `.archives(...)` to cold-tier the tick history before the truncate if you need to keep it for audit, and add an `after` cooldown when you want a grace window before the stream is reaped.

```ts
.autocloses({ is: "RemindersEnded", after: { days: 7 } }) // grace window before reaping
.archives(async (stream, head) => {
  await s3.upload(`reminders/${stream}.jsonl`, await loadHistory(stream));
})
```

See the [close-the-books recipe](../../scaling/close-the-books/README.md) and [archival recipe](../../scaling/archival/README.md) for the operator side of both.

## The durability rule

Every tick's next due-time must derive from that tick's own `created` (or from its payload), never from `Date.now()`. Watermarks and leases last seconds while a recurring loop can run for days, so a competing worker will re-claim the stream between firings. When it re-resolves the schedule against the same tick it has to land on the same due-time as the worker that first deferred, or the loop fires early and drifts. Anchoring `{ after }` to `event.created` and computing every `{ at }` from event data is what keeps the cadence stable across restarts and across competing consumers. This is the same derivability rule the one-shot defer surfaces enforce; recurrence inherits it tick by tick.

## Failure modes

What happens when the machinery under the loop hiccups:

- **The finalize write fails** (store blip at the end of a drain cycle). The schedule is persisted atomically with the cycle's acks — one store call — so a failure lands *nothing*: no ack, no schedule, no lost work. The framework surfaces the error on the `error` lifecycle event and keeps the drain armed; the next cycle redelivers the tick, your handler re-throws its `DeferSignal`, and because the due-time derives from the tick (the durability rule above), it resolves to the same instant. The failure mode is an early redelivery of one tick, never a stalled loop or a half-landed cycle.
- **A worker crashes mid-finalize.** Identical outcome: nothing landed, so the first drain after restart redelivers and finalizes again. This is why the due-time must derive from the tick, not from `Date.now()` — the replacement worker lands on the same schedule.

Both paths assume something drives the drain: live deployments get that from commits/notify, the breaker's retry probe, or a lane `cycleMs` poller (see the production checklist's sizing section).

## Run / test

The example ships with a passing spec that drives the loop with a sub-second cadence and plain waits:

```
pnpm exec vitest run recipes/temporal/recurring-timers/examples/recurring-reminder.spec.ts
```
