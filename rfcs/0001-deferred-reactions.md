# RFC 0001: Deferred reactions & timers

- **Status:** draft <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1049
- **Author:** rotorsoft
- **Created:** 2026-06-27

## Motivation

Act has no way to make something happen *because time passed*. Every reaction
fires because an event arrived; there is no primitive for "if no payment lands
within 30 minutes, expire the order", "ping the customer 24 hours after the
ticket goes quiet", or "on the 90th day after close, archive". This is the
saga-timeout / deadline pattern, and it is table stakes for long-running
workflows: Axon ships a `DeadlineManager`, NServiceBus and MassTransit ship saga
timeouts, Temporal ships durable timers, EventStoreDB ships scheduled messages.

Today an Act user reaches for something outside the framework — an OS cron job, a
`setTimeout` that dies with the process, a separate queue with a visibility
delay. Each of those puts the schedule somewhere that isn't the log: it doesn't
survive a restart the way events do, it isn't auditable or replayable, and it
drifts out of sync with the state it's supposed to guard. The one time-driven
feature Act *does* have, `.autocloses(...)`, proves the appetite — but it is a
single hardcoded purpose (retire a stream N days after a terminal event) riding
a bespoke sweep, not a primitive anyone can reuse.

The need is a first-class, event-sourcing-native way to say "deliver X at time
T" where the schedule is data in the store and the firing is the drain Act
already runs.

## Public surface added

The guiding constraint: **no new runtime dependency** (no cron library), and a
schedule is **data**, not wall-clock state living outside the log. OS/k8s cron
stays an *optional external tick* that calls `app.drain()` — it paces cadence, it
does not own the schedule. This RFC generalizes machinery Act already has
(`HandleResult.next_attempt_at` on the lease/backoff path, and the autoclose
sweep) rather than adding a parallel mechanism.

Two capabilities, each adding public surface:

- **Builder method — reaction deferral (deadline-on-an-event).** A reaction
  handler can defer itself to a future time *without* consuming a retry or
  blocking the stream. The triggering event stays pending (watermark not
  advanced) with its next attempt floored at `T`; at `T` the drain re-delivers,
  and the handler decides — condition met → act and advance, not yet → defer
  again. Proposed shape (final name an open question below): a `defer` helper on
  the handler's app argument, e.g. `app.defer({ after: { minutes: 30 } })` /
  `app.defer({ at: <Date> })`, returning a sentinel the drain understands.
  This is the timeout pattern with no new storage — it reuses
  `next_attempt_at`.

- **Builder method — scheduled timers (fire X at T, no triggering event).** A
  declarative `.schedules({ ... })` chain on `state` (mirroring `.autocloses`)
  and/or a programmatic `app.schedule(stream, event, at)`. The schedule is
  recorded as data (a `TimerSet` / `TimerFired` event pair, or a due-time row)
  and fired by the generalized sweep.

- **Lifecycle / internal refactor (not new surface, but in scope).**
  `.autocloses(...)` is refactored to be **one consumer** of the generalized
  due-time sweep, so core carries a single time mechanism. Existing autoclose
  behavior and its public surface are unchanged.

- **Public types.** Whatever option/result types the two builder methods need
  (e.g. a `Duration`-like `{ after }` shape, a `DeferResult`), named per
  [CLAUDE.md § Naming conventions](../CLAUDE.md#naming-conventions) and
  validated with a Zod `*OptionsSchema` + `resolve*Config` resolver per the
  config-validation standard.

Exact names and signatures are deliberately left to the open questions — this RFC
is asking whether the *shape* (defer-on-handler + declarative/programmatic
timers, sweep-fired, no cron) is right before any of it is named in stone.

## Alternatives considered

- **Do nothing / "compose it above Act".** Tell users to run cron or a queue
  with delayed delivery. Rejected as the default: it pushes the schedule out of
  the log (no durability, no audit, no replay), and it leaves `.autocloses` as
  an unexplained one-off. Note this stays *available* — the external-tick
  recipe is still how you pace the sweep in production; what we reject is making
  it the *only* answer.

- **Add a cron/scheduler library dependency to core.** Rejected. It contradicts
  the "integration helpers live in their own package, core stays minimal" rule,
  and wall-clock cron is the wrong model: the durable thing is the schedule, and
  Act already owns the tick (the drain). A library would duplicate, not reuse.

- **Ship a separate `@rotorsoft/act-scheduler` package** that composes purely on
  public APIs (commit `TimerSet`, a sweep reaction polls due timers). Genuinely
  attractive and keeps core smaller. Rejected as the primary path **because
  `.autocloses` already lives in core** — a second, weaker time mechanism in a
  side package would be the inconsistency, and it couldn't reuse the
  `next_attempt_at` lease path (it would re-poll via its own reaction stream).
  If the project later decides autoclose itself should move out of core, this
  flips to the preferred option.

- **A general workflow / durable-execution engine** (Temporal-style). Rejected
  as out of scope — far more surface and semantics than the need. The goal is
  "deliver this when due, at-least-once", not arbitrary durable control flow.

## Stability / charter impact

- **Category:** Builder API (`state` / reaction handler surface) and public
  types — both charter-covered. Possibly a lifecycle event name if timers
  surface as `TimerSet` / `TimerFired` on the public bus.
- **Additive, not breaking.** Everything here is new optional surface; existing
  builders, `.autocloses`, and drain semantics keep working unchanged. Ships as
  a `feat`-driven **minor**. No `BREAKING CHANGE:` footer.
- **No port method.** The intent is to express deferral and timers on existing
  `Store` capabilities (commit + the watermark's `next_attempt_at`) so no
  `Store` / `Cache` / `Logger` interface change and no TCK/adapter contract
  change is required. If implementation proves a port method is unavoidable,
  that is a charter change requiring its own sign-off and is called out as a
  blocking open question before any code lands.
- **TCK:** even without a port change, due-time delivery needs deterministic
  time injection so the InMemory / act-pg / act-sqlite adapters can be tested
  for identical firing semantics without wall-clock flakiness.

## Open questions

1. **Deferral surface shape.** `app.defer({ after })` helper vs. a returned
   `Defer` sentinel from the handler vs. a `ReactionOptions` field. Which reads
   best and threads cleanly through the existing drain finalizer?
2. **Timer declaration.** Declarative `.schedules({...})` on `state`,
   programmatic `app.schedule(...)`, or both? If declarative, what does the
   predicate/payload look like next to `.autocloses`?
3. **Timers as events vs. rows.** Model timers as first-class `TimerSet` /
   `TimerFired` events on a dedicated stream (fully event-sourced, replayable,
   but adds bus surface) vs. a due-time column the sweep scans (lighter, less
   visible)? This drives whether a lifecycle event name joins the public surface.
4. **Cancellation / rescheduling.** Setting a new timer for the same key should
   replace the old one (like `.autocloses`' "second call replaces"); confirm the
   semantics and how cancellation is expressed.
5. **Time injection for tests.** A clock seam the orchestrator reads, vs. driving
   `app.drain({ now })`. Whichever keeps the TCK deterministic without leaking a
   clock into the public surface.
