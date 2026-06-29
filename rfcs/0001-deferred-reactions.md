# RFC 0001: Deferred reactions & timers

- **Status:** accepted <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1049
- **Author:** rotorsoft
- **Created:** 2026-06-27
- **Amended:** 2026-06-29 (Slice 1 implementation, #1090)

> **Amendment (2026-06-29).** Implementing Slice 1 disproved this RFC's
> load-bearing premise that `next_attempt_at` is a *persisted* per-stream
> column that `claim()` skips on. It is not: `next_attempt_at` lives only in
> process memory (`DrainController._backoff`), is per-worker backoff pacing,
> and `claim()` never reads it. An in-process due-time cannot survive a worker
> rotation — the lease lasts `leaseMillis` (~10s), not the defer duration, so a
> competing consumer re-claims the stream and fires early. Deferral therefore
> **requires persistence**: a new `deferred_at` column on the watermark and a
> required `Store.defer` port method, with `claim()` skipping streams whose
> `deferred_at` is still in the future. This is precisely the "if a port method
> proves unavoidable, call it out before code lands" escape hatch the earlier
> draft named. The sections below are corrected accordingly; the *shape* of the
> design ("scheduling is a stream's next-visit time," no cron, no `schedules`
> table, signals-are-not-sourced) is unchanged — only the persistence mechanism
> and the (now non-zero) `Store` surface.

## Motivation

Act has no way to make something happen *because time passed*. Every reaction
fires because an event arrived; there is no primitive for "if no payment within
30 min, emit `OrderExpired`", "ping the customer 24h after the ticket goes
quiet", or "on the 90th day, archive" — a workflow waiting on the **absence** of
an event. Peers all ship it (Axon `DeadlineManager`, NServiceBus/MassTransit
saga timeouts, Temporal timers). The one time-driven feature Act has,
`.autocloses`, is a hardcoded, single-purpose sweep.

## Design: scheduling is a stream's next-visit time

The shape: **the drain already revisits streams at a future time, conceptually.**
A reaction handler signals a future re-visit; the drain holds the triggering
event pending and re-delivers it when due. Scheduling is just letting a reaction
set that next-visit time **on purpose** — there is no schedule entity, only a
per-stream due-time.

The persistence of that due-time is the one thing this RFC originally got wrong
(see the amendment above). Backoff's `next_attempt_at` is **in-process only**
(`DrainController._backoff`) — per-worker pacing the store knows nothing about.
That is fine for short retry backoff, but a deferral that must hold for minutes,
days, or months across **competing consumers** cannot live in one worker's
memory: the lease expires after `leaseMillis` (~10s), another worker claims the
stream, and with no shared due-time it fires immediately — long before the
deadline.

So the next-visit time is **persisted on the watermark** as a new `deferred_at`
column, and `claim()` skips any stream whose `deferred_at` is still in the
future. This makes deferral correct *and* efficient across workers (no stream is
even claimed before its due-time, so `retry` is never bumped while deferred), and
it is the source of truth. The in-process timer is demoted to a **local
promptness optimization** — it re-arms the deferring worker at the due-time so it
doesn't wait for the next poll, but correctness no longer depends on it.

A timer, therefore, is still not a new entity — it is **a stream + a reaction + a
persisted next-visit time**. No `schedules` table (the due-time is one column on
the existing watermark row), no cron dependency. It *does* add one required
`Store` port method, `defer` — the persistence the in-process assumption wrongly
elided.

## The `defer` outcome — the only new mechanic

A reaction handler can signal `defer(when)` (internally, a thrown `DeferSignal`
the dispatcher recognizes; the public surface is settled in Slice 2). The
orchestrator then:

- persists the **stream's** `deferred_at = when` via `Store.defer`,
- does **not** advance the watermark, and
- does **not** bump `retry_count` (a defer is not a failure — and because
  `claim()` skips a deferred stream entirely, it isn't re-claimed mid-window, so
  `retry` is structurally untouched).

The drain re-delivers the same pending event when `claim()` next returns the
stream (its `deferred_at` having passed), reusing the existing
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
  event, target = the stream. The bespoke sweep is removed. (The close itself
  needs a close-from-reaction primitive — the reaction-scoped `IAct` has no
  `close` today; settled in Slice 1d, see open questions.)
- **Standalone timer** (the only "no source" case): no real event triggers it,
  so the claim cycle delivers a **non-sourced signal** (see below) when the timer
  stream is due (`deferred_at ≤ now`). `app.schedule(stream, opts)` arms it; a
  reaction declared on the signal does the work and may re-arm. Nothing is
  committed to the log. **Sugar — deferred to a follow-up.**

## Signal events are not sourced events

A subtle but load-bearing distinction. An **event-sourced event** is a fact
emitted by an action/reaction — persisted, immutable, replayable, reduced into
state. A **timing signal** is none of those: it is a transient *trigger in the
claim cycle* meaning "run this reaction now, because time T arrived." It carries
no domain fact, so it **must never be committed to the log** — otherwise a
projection rebuild would re-fire every historical timer and state would depend on
wall-clock timing.

The model: a **signal** is declarable so a reaction can target it (`.on(<signal>)`
reads normally), but it is **never emitted by an action**. When the drain finds a
timer stream due (`deferred_at ≤ now`) with no pending events, it synthesizes
the signal *transiently* — not read from the store, not written back. The
reaction's **output** (e.g. `OrderExpired`) is a real, sourced event. So:
**trigger = ephemeral signal; outcome = durable event.**

Consequences to document and uphold:

- A signal never appears in `query`, never replays, never reduces into state.
- Deadlines/recurrence (below) do **not** use signals — their trigger is a *real*
  pending event re-delivered when its `deferred_at` passes. Only standalone timers, which
  have no domain event, use a signal.
- Replay safety falls out for free: rebuilding a projection never re-fires timers,
  because the signals were never in the log to begin with.

## Public surface added

- **`Store.defer(input, deferred_at)`** — a new **required** port method
  (`input: string[] | StreamFilter`, mirroring `reset`/`unblock`/`prioritize`),
  joining the watermark verb family **claim / ack / block / defer**. Plus the
  `deferred_at` column on the watermark and `claim()`'s skip-until-due behavior.
  Charter-covered `Store` change; lands with TCK coverage and all three in-tree
  adapters in lockstep (a required method can't be staged adapter-by-adapter).
- **Reaction outcome `defer(when)`** (exact public shape — returned sentinel vs.
  `app.defer(...)` — settled during Slice 2; internally a `DeferSignal`).
- **`when` options type** (`after` / `at` / `every`), Zod-validated per the
  config-validation standard.
- **Builder validation** rejecting invalid scheduling/`source`/`target`
  configurations at `.build()` (same family as the cross-slice-schema throw and
  the lane-disagreement throw).
- *(follow-up)* `app.schedule(stream, opts)` / `app.unschedule(stream, key)`.
- **No `schedules` table** — the due-time is one column on the existing watermark
  row, not a separate entity.

## Cancellation / reschedule

- Re-defer overwrites `deferred_at`; advancing the watermark (an `ack`) clears it
  and ends the schedule.
- One pending next-visit **per stream** (the watermark is keyed by `stream`
  alone — see open questions), so independent schedules are **separate streams**
  (a timer *is* a stream) rather than multiple rows on one — which is what removes
  the need for a schedules table.

## Test clock

- Inject `now()` (an `ActOptions`/internal seam, default `Date.now`), and drive
  the sweep with explicit `app.drain()` — never a background timer in tests.
  Tests advance the clock + drain → deterministic firing, no wall-clock sleeps.
  Matches the existing "explicit `correlate`/`drain` over `settle`" convention.

## Alternatives considered (rejected)

- **A separate `schedules` store/table** (the earlier draft of this RFC).
  Rejected: a timer is fully described by a due-time on the stream it already has,
  so a dedicated table duplicates the watermark row and makes cancellation a
  row-mutation problem. The persisted `deferred_at` column lives **on the existing
  watermark**, not in a new table. (Note: the earlier draft also rejected *any*
  new `Store` port method on the assumption that `next_attempt_at` was already
  persisted; that assumption was wrong — see the amendment — so a single required
  `defer` method *is* added. What stays rejected is a separate schedules
  **entity**.)
- **Cron library / cron-string parsing.** Rejected: a dependency and brittle.
  Structured `every` covers the common cases; full cron is userland.
- **Sourceless / time-only reactions as ordinary reactions.** Rejected: a
  reaction needs something to react to. Standalone timers instead deliver a
  **non-sourced signal** (see "Signal events are not sourced events") — declarable
  for `.on(...)` but synthesized transiently by the claim cycle, never committed.
- **A committed seed/`Scheduled` event to bootstrap a timer stream** (an earlier
  idea in this RFC). Rejected: it would put a synthetic, non-domain event in the
  log, which then replays. The non-sourced signal avoids that entirely.
- **Timers as `TimerSet`/`TimerFired` events on the log.** Rejected: scheduling
  is mutable operational state (reschedule/cancel), not domain history. With the
  defer model there is no schedule entity at all — only the watermark's
  `deferred_at`; the timer's *firings* are normal events.

## Stability / charter impact

- `defer` outcome + `when` options + builder validation = **additive** builder /
  `IAct` surface → minor.
- **`Store` port change: one new required method `defer` + a `deferred_at`
  column + `claim()` skip-until-due.** Additive to the interface (new method, no
  signature change to existing ones) → minor, but charter-covered: it ships with
  TCK coverage and all three in-tree adapters (InMemory, `act-pg`, `act-sqlite`)
  in lockstep, per the "changing a port interface" rule. `subscribe`/`reset`/
  `unblock`/`ack`/`block` clear `deferred_at`.
- One internal change: the ack/lease path distinguishes a deliberate `defer`
  (persist `deferred_at`, no retry bump) from a backoff (in-process pacing).

## Open questions

1. **`defer` surface shape** — returned sentinel vs. `app.defer(...)`. Settle in
   Slice 2. (Internally already a `DeferSignal` thrown by the handler.)
2. **Watermark key** — ~~`stream` vs. `(stream, source)`~~. **Resolved (Slice 1
   spike):** the watermark/lease is keyed by **`stream` alone**; `source` is a
   filter, not part of the key. So one pending `deferred_at` per stream, and a
   defer affects every reaction draining that stream — which is why independent
   schedules are separate streams, and why the builder must reject configurations
   that would put conflicting deadlines on one stream (Slice 2 validation).
3. **Close from a reaction** — the reaction-scoped `IAct` exposes no `close`, so
   autoclose's compiled reaction can't close directly. Settle the primitive in
   Slice 1d (a close-from-reaction signal handled by the orchestrator, or adding
   `close` to the scoped app).

## Sequencing (epic #1049)

1. **`defer` primitive + persisted due-time + port autoclose** (#1090). Because
   `defer` is a required `Store` method, the contract + `deferred_at` column +
   `claim()` skip + InMemory + `act-pg` + `act-sqlite` + TCK land **atomically**
   (1a–1c), then autoclose ports onto it (1d) — autoclose's behavioral tests must
   pass on the new infra. The drain-side outcome (`HandleResult.defer`,
   `DeferSignal`, the `DrainController` refactor) is already built.
2. **Public `defer(when)` — deadlines** + builder validation + TCK/scenario
   tests.
3. **Recurrence (`every`)** + builder validation + tests.
4. **Standalone timer streams** — `app.schedule` arms a due-time on a timer
   stream; the claim cycle delivers a **non-sourced signal** when due. Follow-up.
