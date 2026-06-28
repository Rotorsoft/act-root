# RFC 0001: Deferred reactions & timers

- **Status:** accepted <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1049
- **Author:** rotorsoft
- **Created:** 2026-06-27

## Motivation

Act has no way to make something happen *because time passed*. Every reaction
fires because an event arrived; there is no primitive for "if no payment within
30 min, emit `OrderExpired`", "ping the customer 24h after the ticket goes
quiet", or "on the 90th day, archive" — a workflow waiting on the **absence** of
an event. Peers all ship it (Axon `DeadlineManager`, NServiceBus/MassTransit
saga timeouts, Temporal timers). The one time-driven feature Act has,
`.autocloses`, is a hardcoded, single-purpose sweep.

## Design: scheduling is a stream's next-visit time

The key realization (which collapses an earlier, heavier draft): **the drain
already revisits streams at a future time.** Every stream watermark carries
`next_attempt_at`; that's how backoff works — the finalizer sets it, `claim()`
skips the stream until then, and the same pending event is re-delivered. So
`next_attempt_at` *is* the per-stream timing persistence, and scheduling is just
letting a reaction set it **on purpose**.

A timer, therefore, is not a new entity — it is **a stream + a reaction + a
next-visit time**. No `schedules` table, no new `Store` port method, no cron
dependency.

## The `defer` outcome — the only new mechanic

A reaction handler can signal `defer(when)`. The orchestrator then:

- sets the **stream's** `next_attempt_at = when`,
- does **not** advance the watermark, and
- does **not** bump `retry_count` (a defer is not a failure).

The drain re-delivers the same pending event when due, reusing the existing
hold-and-redeliver path. `defer` acts **within the running reaction's
`source → target` context** — there is no sourceless reaction.

`when` is a structured options bag — never a cron string (that needs a parser
dependency and is brittle):

```ts
{ after: { minutes: 30 } }        // relative deadline
{ at: (event) => event.data.due } // absolute
{ every: { hours: 1 } }           // recurrence: re-deliver each interval
```

Full cron expressions stay **userland**: parse → compute the next `Date` →
`defer({ at })`. Core stays dependency-free.

## How every case falls out — no sourceless timers

- **Deadline** (has a source): react to `OrderPlaced`; if unpaid,
  `defer({ after: { minutes: 30 } })` without advancing; re-check on
  re-delivery; advance + act when met.
- **Recurring** (has a source): `defer({ every: { hours: 1 } })` re-delivers the
  *same* event each interval; the watermark never advances until you stop.
- **autoclose** (has a source): a reaction on the *terminal* event defers the
  close to `terminal + N days`, then closes on re-delivery. Source = terminal
  event, target = the stream. The bespoke sweep is removed.
- **Standalone timer** (the only "no source" case): bootstrap with a seed event
  on a dedicated stream (`app.schedule(stream, opts)` commits a `Scheduled`
  event); a reaction on it defers/recurs. The seed event *is* the source; source
  and target are both the timer stream. **Sugar — deferred to a follow-up.**

## Public surface added

- **Reaction outcome `defer(when)`** (exact shape — returned sentinel vs.
  `app.defer(...)` — settled during Slice 2).
- **`when` options type** (`after` / `at` / `every`), Zod-validated per the
  config-validation standard.
- **Builder validation** rejecting invalid scheduling/`source`/`target`
  configurations at `.build()` (same family as the cross-slice-schema throw and
  the lane-disagreement throw).
- *(follow-up)* `app.schedule(stream, opts)` / `app.unschedule(stream, key)`.
- **No new `Store` port method, no `schedules` table.**

## Cancellation / reschedule

- Re-defer overwrites `next_attempt_at`; advancing the watermark ends the
  schedule.
- One pending next-visit **per stream**, so independent schedules are **separate
  streams** (a timer *is* a stream) rather than multiple rows on one — which is
  what removes the need for a schedules table.

## Test clock

- Inject `now()` (an `ActOptions`/internal seam, default `Date.now`), and drive
  the sweep with explicit `app.drain()` — never a background timer in tests.
  Tests advance the clock + drain → deterministic firing, no wall-clock sleeps.
  Matches the existing "explicit `correlate`/`drain` over `settle`" convention.

## Alternatives considered (rejected)

- **A `schedules` store/table + new `Store` port method** (the earlier draft of
  this RFC). Rejected: `next_attempt_at` already *is* per-stream timing
  persistence; a new table duplicates it and makes cancellation a row-mutation
  problem. Superseded by "defer the stream."
- **Cron library / cron-string parsing.** Rejected: a dependency and brittle.
  Structured `every` covers the common cases; full cron is userland.
- **Sourceless / time-only reactions.** Rejected: breaks the `source → target`
  model. Standalone timers use a seed event instead.
- **Timers as `TimerSet`/`TimerFired` events on the log.** Rejected: scheduling
  is mutable operational state (reschedule/cancel), not domain history. With the
  defer model there is no schedule entity at all — only `next_attempt_at`; the
  timer's *firings* are normal events.

## Stability / charter impact

- `defer` outcome + `when` options + builder validation = **additive** builder /
  `IAct` surface → minor.
- **No `Store` port change** (reuses `next_attempt_at`).
- One internal change: the ack/lease path distinguishes a deliberate `defer`
  (set `next_attempt_at`, no retry bump) from a backoff.

## Open questions (small, resolved during implementation)

1. **`defer` surface shape** — returned sentinel vs. `app.defer(...)`. Settle in
   Slice 2.
2. **Watermark key** — `stream` vs. `(stream, source)`. Spiked in Slice 1; it
   decides whether a defer affects all reactions on a stream or one source's, and
   shapes the builder validation rules.

## Sequencing (epic #1049)

1. **`defer` primitive + port autoclose** (proving ground; no new public
   surface; autoclose's existing tests must pass on the new infra).
2. **Public `defer(when)` — deadlines** + builder validation + TCK/scenario
   tests.
3. **Recurrence (`every`)** + builder validation + tests.
4. **Standalone timer streams** (`app.schedule` seed-event helper) — follow-up.
