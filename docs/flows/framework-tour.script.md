# Act framework tour: the script

The storyboard behind the animated tour (`docs/src/tours/framework-tour.ts`, played by
`docs/src/components/Tour`, hosted by the standalone page `docs/src/pages/tour.tsx`, at `/act-root/tour`). The subject is the framework:
what each capability does, shown as what it does to the event store. The domain is a thin
backdrop, mostly a small ticket desk cut down from `packages/wolfdesk`.

Every claim below was checked against `libs/act/src/` and the guarantee table in
`docs/docs/architecture/behavior-contracts.md`. **Doc** is a page under `docs/docs/`.
**Test** is a spec under `libs/act/test/` unless it names another package.

## The screen

Two parts only: the **stage**, which takes the whole width and every pixel of height above
one slim **control row**. In full screen the stage takes the whole display. There is no
frame, no title row and no side panel.

The stage has two linked centers. The **event store** is the main one, on the right, at
about 60% of the width: the whole store as a field of dots (a seeded, deterministic history
of 1,000 to 2,000 events per macro chapter), the detailed cells under a lens, the counts in
its header, and, in chapters about reactions, one quiet track per subscription on the
store's id axis. The **running Act app** is the second, on the left: the `app.do` gate and
the operator entry points, the **action layer** (payload, load, preconditions, handler,
fold, state check, then the commit port) and the slices with their states, actions,
events, reactions and projections. The app's content scales up as one group to fill its
frame, and stands the action layer upright when it has height to spare. One link joins the
two: commits go in through the port, loads and reactions read back out. **Actors** are
small icons at the left edge (a person for people, a gear for automations), and read models
sit under them.

Code never shows on the stage. Every element with code behind it carries a `</>` icon in
the same top-right slot, which opens the snippet, the API and the doc and test links.

Each step dims everything it doesn't touch to a fifth and gives the area it works in (the
action layer, the store) a soft glow. Data moves as a token with a short trail of
particles, along the drawing and never across it: in at `app.do`, along the action layer,
out of the commit port, along the link, in at the store's edge, then down to the slot it
lands in. Where the lens shows ids that aren't adjacent, a dashed marker names the skipped
range. Every number on screen is filled in from the fold, not written by hand; example days
and policies are marked as picked for the example.

The **control row** holds the chapter button ("Chapter 3 of 18 · Rules … · step 2/6"), with
a progress bar across its top segmented by chapter, then step back, play and step forward,
the step's `</>` tip, CC, sound, music and its volume, the voice, the speed, the transcript
drawer and full screen. The chapter menu is a panel that fits the viewport (a bottom sheet
on a phone). Playing runs on from chapter to chapter, with a short spoken title card
between them, so playing from chapter 0 runs the whole tour.

## Narration

Each step's `say` line is both the caption and the narration. Captions are subtitles
inside the stage: a translucent, blurred bubble sized to the text, at most two lines, one
sentence at a time, in plain words with no code chips. The layout keeps that strip free.
The voice is the browser's speech synthesis, using the most natural voice it offers
(Natural, Neural, Premium, Enhanced or Online voices first, in the page's language), which
the viewer can change. It reads at 0.95, pauses briefly between sentences and longer between
steps, and the step waits for the voice. A generated ambient pad (Web Audio, no files) plays
under it and ducks about 12 dB while the voice speaks. Without speech, captions are timed.

The narration is written in the voice of the Act book: flowing sentences, a concrete moment
at the ticket desk, the problem before the solution, no lists and no code read aloud. Each
chapter's first step opens on the problem that chapter solves:

| Chapter | The moment it opens on |
|---|---|
| 0 | a ticket says closed and nobody can say why; every update was a small act of forgetting |
| 1 | a manager asks why one ticket took a week to close, which a table of rows can't answer |
| 2 | Maya's screen keeps flickering, and the desk needs a ticket that knows what it is |
| 3 | rules scattered across controllers drift apart |
| 4 | two agents, one ticket, the same instant |
| 5 | a ticket's whole life replayed on every action would get slow |
| 6 | a new ticket shouldn't sit waiting for someone to notice it |
| 7 | Monday morning, and one process can't keep up |
| 8 | two in the morning, and the escalation service is down |
| 9 | an untouched ticket should escalate on its own, with no cron job |
| 10 | the support screen needs a fast list of tickets |
| 11 | an agent carries five tickets at most, a rule that lives on the agent |
| 12 | a customer asks the desk to forget her |
| 13 | a year on, closed tickets still cost storage |
| 14 | nobody wants to close tickets by hand, months later |
| 15 | after the closing and pruning, the store is full of holes |
| 16 | the desk grows to two servers on one store |
| 17 | agents click buttons in a browser, they don't call `app.do` |
| 18 | everything ran against one port, the store |

The tables below are the beat outline each chapter was built from; the spoken lines live in
the spec.

## The picture that never leaves the screen

The store is one global log, the "all" stream. Every event sits in it in commit order with
its global `id`. Each event belongs to one stream and has that stream's `version`, so many
streams interleave in one log. Every dot shares one neutral tone; the streams a scene is
about, a hovered stream and the active cell light up in one accent color. Snapshots,
tombstones and sensitive events keep subtle glyphs in the same tone (a ring, a cap, a
hollow center).

Every operation in the tour is drawn as what it does to that log:

| Operation | What the log shows |
|---|---|
| commit | new cells append at the tail, one id each; several streams in one commit share a bracket |
| refused in the action layer (`ValidationError`, `StreamClosedError`, `PreconditionError`, the state check) | nothing reaches the store: the token stops in red inside the app, at the stage that refused it, with a note on its own row |
| `ConcurrencyError` | the only refusal at the store: a red pill in the store's own row at its entry edge shows the expected and the actual version; nothing is appended |
| `StoreError` / breaker | the store itself is unavailable: its frame turns red and dashed; not a refusal |
| snapshot | a `__snapshot__` cell, on its stream's next version |
| correlate | the checkpoint marker moves along the log |
| drain | a worker's lease on a target, its watermark marker moves along the target's track |
| defer / backoff | the target shows a due time; claim skips it |
| blocked | the target turns red; its watermark stops |
| close | a `__tombstone__` guard appends, the stream's dots lift into the archive, one seed appends at v0 |
| windowed close | the cells below the closest safe snapshot fade out; the stream stays live |
| forget | each sensitive event of the stream gets a shredded mark |
| restore | the log is rebuilt and ids renumber densely |

The app keeps the docs' diagram tokens (`--dg-*`): actor slate, action blue, state amber,
event orange, projection green, reaction purple, outside world pink, store teal.

## Chapters

Simple to complex. The audience tag says who the chapter is mostly for: **first app**
(an app developer meeting Act), **production** (an app developer going to production),
**operator** and **adapter author**.

---

### 0. How to read this tour · everyone

A prologue of about 90 seconds. It opens on the problem: a customer's ticket says closed,
nobody remembers closing it, and a system that kept only the current row can never say why,
because every update was a small act of forgetting. Act keeps every change as an event in
one log instead. Then it walks the screen, lighting each part as it is named: the actors,
the app and its action layer, the slices with their reactions and projections, the event
store, a highlighted stream, a commit flowing along the link into the log, the `</>` icon,
captions and sound, and the controls. Its own small app (`APP_PROJ`) and three seeded
events keep it independent of chapter 1.

---

### 1. One log, many streams · first app

**Scenario.** A ticket desk's store already holds a few events: a ticket opened, an agent
added, a second ticket opened, a message on the first ticket.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 1.1 | The log with four cells, ids #0–#3, two colors interleaved | "Act keeps every change as an event in one ordered log. Each event gets a global id when it commits." | `Committed` (`id`, `stream`, `version`, `name`, `data`, `created`, `meta`) |
| 1.2 | The lens zooms in on the cells: `ticket-4821` v0, v1; `agent-ana` v0; `ticket-4822` v0 | "Each event also belongs to one stream and takes that stream's next version. Streams interleave in the log." | `app.query_array({ stream, stream_exact: true })` |
| 1.3 | A cell opens to show `meta.correlation` and `meta.causation` | "Every event carries who caused it: the action, its actor, and a correlation id that a whole workflow shares." | `meta.correlation`, `meta.causation.action` |

Doc: `concepts/event-sourcing.md#event-store`. Test: `libs/act-tck/src/store-tck.ts` → "lands
every append, each from its own head, with ids in append order".

---

### 2. A state and its first action · first app

**Scenario.** Maya, a customer, opens ticket 4830, then adds a message.

```ts
const Ticket = state({ Ticket: z.object({ title: z.string(), status: z.string(), messages: z.number() }) })
  .init(() => ({ title: "", status: "new", messages: 0 }))
  .emits({ TicketOpened: z.object({ title: z.string() }), MessageAdded: z.object({ body: z.string() }) })
  .patch({
    TicketOpened: ({ data }) => ({ title: data.title, status: "open" }),
    MessageAdded: (_, state) => ({ messages: state.messages + 1 }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
    .emit("TicketOpened")
  .on({ AddMessage: z.object({ body: z.string() }) })
    .emit("MessageAdded")
  .build();
const app = act().withState(Ticket).build();
```

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 2.1 | Code card: `state(...)` with `.init/.emits/.patch/.on/.emit/.build` | "A state is a Zod schema, an initial value, the events it emits, how each event patches it, and the actions that emit them." | `state`, `.init`, `.emits`, `.patch`, `.on`, `.emit`, `.build`, `act().withState().build()` |
| 2.2 | Token: actor → action `OpenTicket`; the payload is checked | "`app.do` validates the payload against the action's schema first." | `app.do(action, { stream, actor }, payload)` |
| 2.3 | Token: action → state card; the state loads at its initial value, version −1 | "Then it loads the stream. A new stream starts at the initial state, version −1." | `.init` |
| 2.4 | The handler returns `TicketOpened`; the state card folds it (`status: open`) | "The handler decides the events. Each folds into the state once, through its patch, before anything is stored." | `.patch` (an event with no patch merges its data into the state) |
| 2.5 | Token: state → log; cell #4 appends; `ticket-4830` (a new stream) v0 | "The commit expects version −1. It lands: global id #4, stream version 0." | `expectedVersion` (derived) |
| 2.6 | Second action: `AddMessage` → cell #5, v1 | "The next action loads v0 and commits v1. Each action returns one snapshot per event it committed." | `Snapshot` (`state`, `version`, `event`, `patch`) |
| 2.7 | `app.load(Ticket, "ticket-4821")`: token log → state card, state folds v0..v1 | "`app.load` rebuilds the state from the stream's events." | `app.load(State, stream)` |

Doc: `guides/getting-started.md`, `concepts/state-management.md#what-an-action-checks-in-order`.
Test: `invariants.spec.ts` → "folds each event once, with the next version and a placeholder id";
`version-guard.spec.ts` → "lets only one of two callers create a new stream".

---

### 3. Rules: preconditions and invariants · first app

**Scenario.** Someone tries to close a ticket that is already closed, and an action tries
to leave the ticket in a state its schema forbids.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 3.1 | Check list on the action: payload ✓, load ✓, preconditions, handler, fold, state check, commit | "An action passes six checks in order, and refuses at the first that fails. Nothing is stored." | the order in state-management |
| 3.2 | Payload `{ title: 42 }` refused at row 1, ghost cell, `ValidationError` | "A payload that breaks the action's schema is a `ValidationError`." | `ValidationError` |
| 3.3 | `CloseTicket` with `.requires([mustBeOpen])` on a closed ticket: ✕ at the precondition; `PreconditionError` "CloseTicket failed precondition: Ticket must be open" | "A precondition is a named rule the action needs right now. The first one that doesn't hold refuses the action." | `.requires([{ description, holds }])`, `PreconditionError` |
| 3.4 | State schema with `.refine(..., "A closed ticket has a closer")`; the fold leaves a closed ticket with no closer; ✕ at the state check, `ValidationError` | "What must hold after every action is an invariant, and it lives in the state's schema. The final state is checked once, before the commit." | state schema refinements |
| 3.5 | The log unchanged | "Refusals never touch the log, and no reaction wakes." | |

Doc: `concepts/state-management.md#preconditions`, `#invariants`. Test:
`preconditions.spec.ts` → "refuses at the first precondition that doesn't hold, and commits nothing";
`invariants.spec.ts` → "refuses before the commit: nothing is stored, no reaction runs, the stream keeps working".

---

### 4. Two writers, one stream · first app

**Scenario.** Maya and the agent Ana add a message to ticket 4821 (at v1) at the same moment.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 4.1 | Two tokens load the stream; both see v1 | "Both actions load ticket 4821 at version 1." | |
| 4.2 | Maya's commit lands as v2 (#7); Ana's commit expects 1, finds 2: red ghost cell | "The first commit wins. The other expected version 1 and found 2: `ConcurrencyError`, with `stream`, `expectedVersion` and `lastVersion`." | `ConcurrencyError` |
| 4.3 | `.on({ AddMessage }, { maxRetries: 2 })`: Ana's action reloads v2, re-checks, commits v3 (#8) | "With a retry budget on the action, Act reloads and runs it again on the new state; its rules are checked again." | `.on(entry, { maxRetries, backoff })` |
| 4.4 | A caller pins `expectedVersion: 1`: refused at once, no retry | "A version the caller pins is a fixed conflict: it is thrown at once, never retried." | `{ stream, actor, expectedVersion }` |

Doc: `concepts/error-handling.md#concurrencyerror`, `architecture/concurrency-model.md`.
Test: `action-retry.spec.ts` → "succeeds on second attempt after one conflict",
"rethrows immediately without consuming the retry budget or sleeping".

---

### 5. Loading fast: cache, snapshots, time travel · production

**Scenario.** Ticket 4821 grows; the app snapshots it every five events (a small number so
it fits on screen).

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 5.1 | A warm load: the state card reads from the cache, no log read | "A load starts from the cache (in memory by default) and replays only what came after it." | `cache()`, `InMemoryCache` |
| 5.2 | `.snap((s) => s.patches >= 5)` on the state; the next action appends its event, then a `__snapshot__` cell on the next version | "A snapshot is an event too: `__snapshot__`, committed right after the action's events, on the stream's next version." | `.snap(predicate)`, `SNAP_EVENT` |
| 5.3 | Cold load: the cache empties; the load starts at the snapshot cell and folds only what follows | "When the cache is cold, the load starts from the latest snapshot." | |
| 5.4 | Time travel: `app.load(Ticket, "ticket-4821", undefined, { before: 8 })`: the cells from #8 on dim | "A time-travel load skips the cache and replays the real events below the cutoff. It is read-only." | `AsOf` (`before`, `created_before`, `created_after`, `limit`) |

Doc: `architecture/cache-and-snapshots.md`, `concepts/event-sourcing.md#time-travel-queries`.
Test: `event-sourcing.spec.ts` → "should persist snapshot event on snap success",
"should load from a snapshot event on cold start"; `time-travel.spec.ts` → "`before` id cutoff — folds only pre-cutoff events".

---

### 6. A reaction · first app

**Scenario.** When a ticket opens, an `assign` reaction picks an agent.

```ts
act()
  .withState(Ticket)
  .on("TicketOpened")
    .do(async function assign(event, stream, app) {
      await app.do("AssignTicket", { stream: event.stream, actor: bot }, { agent: "bo" });
    })
    .to((event) => ({ target: `assign:${event.stream}`, source: event.stream }))
  .build();
```

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 6.1 | `TicketOpened` commits on `ticket-4830` (#n) | "A commit whose events have a reaction schedules `settle()` on its own." | `.on(event).do(handler).to(resolver)` |
| 6.2 | Correlate: the checkpoint marker walks to the new cell; the resolver names target `assign:ticket-4830`; it appears in the targets table with a work mark | "Correlate reads the log past its checkpoint and asks each reaction's resolver which target stream handles the event. New targets are subscribed, and their work is marked." | `app.correlate()` |
| 6.3 | Drain: a worker leases the target; the target's watermark sits at −1 | "Drain claims targets that have work, each with a lease, and fetches the source's events past the target's watermark." | `app.drain()` |
| 6.4 | Handler runs: token reaction → action `AssignTicket` → log: `TicketAssigned` appends, same correlation, cause = `TicketOpened` | "The handler's `app.do` inherits the event that woke it: same correlation, and the event as its cause." | auto-injected `reactingTo` |
| 6.5 | Ack: the watermark moves to the `TicketOpened` cell; lease released | "On success the drain acks: the watermark moves past the event, and the lease is released." | |
| 6.6 | Settle runs one more pass, finds nothing, emits `settled` | "Settle loops correlate and drain until nothing is left, then emits `settled`." | `app.settle()`, `app.on("settled")` |
| 6.7 | Code card: `.to(...)` omitted → the target is the event's own stream; a test builds with `autoSettle: false` and calls `correlate()` then `drain()` | "Leave out `.to` and the reaction runs on the event's own stream. Tests can walk the steps by hand." | `fixture(builder)`, `build({ autoSettle: false })` |

Doc: `architecture/correlation-and-drain.md`, `concepts/state-management.md#auto-injected-reactingto`,
`concepts/testing.md`. Test: `correlate.spec.ts` → "marks the target with the id of the event that resolved to it";
`settle-wakeup.spec.ts` → "runs the reaction with no settle wiring"; `reacting-to.spec.ts` → "should auto-inject reactingTo when handler omits it".

---

### 7. Many workers, lanes and priority · production

**Scenario.** Two processes drain the same store; escalation webhooks get their own lane.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 7.1 | Workers A and B claim at once; each target gets exactly one lease | "Workers compete for targets. An unexpired lease is invisible to the others, so each target has one worker at a time." | `Store.claim` |
| 7.2 | Worker A stops; its lease runs out; B claims the target | "When a lease expires, exactly one other worker takes it over." | `leaseMillis` |
| 7.3 | `.withLane({ name: "webhooks", leaseMillis: 30_000, streamLimit: 5 })`, `.to({ target, lane: "webhooks" })`: the targets table splits into two lanes, each with its own controller | "A lane is a separate drain controller with its own lease and claim budget. Lanes drain in parallel, so a slow one doesn't hold up the default lane." | `.withLane`, `.to({ lane })`, `onlyLanes` |
| 7.4 | `.to({ target, priority: 10 })`, `app.prioritize(filter, n)` | "Inside a lane, priority decides which behind targets are claimed first when the worker is saturated. It never reorders a stream's events." | `priority`, `app.prioritize` |

Doc: `concepts/configuration.md#lanes`, `architecture/priority-lanes.md`, `architecture/concurrency-model.md`.
Test: `libs/act-tck/src/store-tck.ts` → "does not hand an unexpired lease to a competing claimer",
"hands an expired lease to exactly one competing claimer, with retry accounting shared across workers";
`lanes.spec.ts` → "drains lanes in parallel — a stalled slow handler does not block the fast lane".

---

### 8. When a reaction fails · production

**Scenario.** The escalation webhook's receiver is down, then it rejects a request.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 8.1 | Code card: `backoff: { strategy: "exponential", baseMs: 200, maxMs: 10_000, jitter: true }`. Attempt 1 fails (503); the target shows retry 1 and a clock "200 ms × jitter" | "A failed attempt waits out the backoff in the code card: `baseMs` for the first retry, times a jitter factor between 0.5 and 1.5. The schedule is stored on the target, so every worker honors it." | `.do(handler, { maxRetries, backoff })` |
| 8.2 | Attempts 2–4 fail; the target turns red: blocked; `blocked` fires | "After `maxRetries + 1` attempts the target blocks. Its watermark stays where it was." | `blockOnError`, `app.on("blocked")`, `app.blocked_streams()` |
| 8.3 | The receiver comes back; `app.unblock([target])`; the drain resumes at the watermark | "`app.unblock` resumes at the watermark. Nothing before it runs again." | `app.unblock` |
| 8.4 | A 400 answer: the handler throws `NonRetryableError`; blocked at the first attempt | "A `NonRetryableError` blocks at once, without spending the budget (unless `blockOnError` is false)." | `NonRetryableError` |
| 8.5 | Contrast: `app.reset([target])` rewinds the watermark to −1: every webhook would run again | "`app.reset` replays everything. Use it to rebuild, not to recover." | `app.reset` |
| 8.6 | The store turns red; `error` fires; breaker "open"; a retry after `cooldownMs` | "When the store itself fails, a circuit breaker stops the loops from hammering it and retries after a cooldown." | `circuitBreaker`, `app.on("error")`, `StoreError` |

Doc: `concepts/error-handling.md#blocked-streams`, `#backoff`, `#non-retryable-errors`, `#store-failures-and-the-circuit-breaker`.
Test: `backoff.spec.ts` → "defers retry until backoff window elapses (persisted schedule)", "spends the whole retry budget and blocks";
`non-retryable.spec.ts` → "blocks on first attempt when blockOnError is true (default)", "recovers via app.unblock without replaying history".

---

### 9. Timers: deferred reactions · first app

**Scenario.** A ticket assigned with `escalateAfter` escalates if nothing happens by then.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 9.1 | `.on("TicketAssigned").defer((e) => ({ at: e.data.escalateAfter })).do(autoEscalate).to(...)`: the target shows a clock with the due time; the event stays pending | "`.defer` holds a reaction until its due time, then runs it once. The due time derives from the event, never from `Date.now()`." | `.defer(when)`, `{ after }` / `{ at }` |
| 9.2 | Claim skips the target until due; at due time a worker claims it, the handler escalates: `TicketEscalated` appends | "The schedule is stored, so any worker runs it when it is due, even after a restart." | |
| 9.3 | Another ticket: the handler finds the ticket closed and returns; ack, nothing appends | "A timer that wakes to find nothing to do just returns." | |
| 9.4 | `throw new DeferSignal({ at })` from inside a handler | "When the wait depends on loaded state or a branch, the handler throws `DeferSignal` instead." | `DeferSignal` |
| 9.5 | Two reactions share a target; one defers; both run again when due. With its own `.to(...)`, only the deferred one waits | "Reactions on one target are one group: a defer redelivers the whole group, unless it has its own target." | |

Doc: `concepts/state-management.md#deferred-reactions`. Test: `defer.spec.ts` → "literal \{ after \} holds the
reaction (handler not run, not acked)", "\{ at: Date \} holds until the due-time, then acts",
"re-runs a sibling that shares the deferred reaction's target, but not an isolated one".

---

### 10. Projections, slices and rebuilds · first app

**Scenario.** A `tickets` table for the desk's list view.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 10.1 | `projection("tickets").of(Ticket).flush(rows => ...)`: a table appears beside the store, target `tickets` in the targets table | "A projection is a reaction that writes a read model. A state projection folds the state's own patches and flushes one row per stream." | `projection(target)`, `.on({ Event }).do(...)`, `.batch`, `.of(...).flush(...)` |
| 10.2 | Commits flow; the table rows update after each drain | "It drains like any reaction, with its own watermark." | |
| 10.3 | `slice().withState(...).withProjection(...).on(...)...build()`, `act().withSlice(...)` | "A slice groups partial states, projections and reactions into one feature. Partials with one name merge into one state." | `slice`, `.withSlice`, `.withProjection` |
| 10.4 | `app.reset(["tickets"])`: the table empties (the app's job), the watermark jumps to −1, the replay walks the whole log and refills it | "To rebuild, reset the projection's target. The reset schedules the replay on its own." | `app.reset(targets | filter)` |

Doc: `concepts/event-sourcing.md#projection-rebuild`, `guides/projections-to-database.md`,
`concepts/state-management.md#slices`. Test: `rebuild.spec.ts` → "should enable replay of projection after reset";
`settle-wakeup.spec.ts` → "replays a reset target with no settle call".

---

### 11. Rules across streams: `.loads` · production

**Scenario.** Assigning a ticket takes a slot from an agent, and an agent holds at most five
open tickets (the `Agent` state in wolfdesk).

```ts
.on({ AssignTicket }, { maxRetries: 4 })
  .loads(Agent, (_, s) => s.agentId && `agent-${s.agentId}`, ["TicketDropped"], "current")
  .loads(Agent, (data) => `agent-${data.agentId}`, ["TicketTaken"], "next")
  .requires([mustBeOpen])
  .emit((data) => [["TicketAssigned", data], ["TicketDropped", {}], ["TicketTaken", {}]])
```

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 11.1 | A fresh store: two agents (Bo already holds five), tickets 5200 and 5201. `AssignTicket` 5200 → Ana loads the ticket and `agent-ana`; the `current` target returns `undefined`, so that load is skipped | "`.loads` loads another state the decision needs. A target that returns `undefined` skips its load." | `.loads(State, target, events, name?)` |
| 11.2 | One bracket: two cells append together on two streams, consecutive ids (#9, #10) | "Every event lands in one commit, each stream guarded by the version it had at load. All or nothing." | |
| 11.3 | 5201 → Bo: the fold breaks `open ≤ 5`; ✕, nothing on any stream | "The loaded state's schema guards its fold, whichever action emits into it." | `ValidationError` |
| 11.4 | 5201 → Ana loads `agent-ana` at v1; meanwhile `CloseTicket` on 5200 drops Ana's slot in its own commit (v2); Lee's commit fails with `ConcurrencyError` naming `agent-ana` | "If any loaded stream moved, the whole commit fails, naming that stream." | `ConcurrencyError.stream` |
| 11.5 | The retry reloads and commits (#13, #14) | "The action's retry budget runs it again with fresh loads. A load without events is only a read, and isn't guarded." | `maxRetries` |

Doc: `guides/rules-across-streams.md`, `concepts/state-management.md#rules-across-streams-loads`.
Test: `loads.spec.ts` → "commits to both streams at once and returns its own snapshots";
`libs/act-tck/src/store-tck.ts` → "stores nothing when the first, a middle or the last append is stale, and names its stream".

---

### 12. Sensitive data · production

**Scenario.** A user registers with an email; later they ask to be forgotten.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 12.1 | `email: sensitive(z.string().email())`; the commit splits: `data { plan }`, lock `pii { email }` in the same cell | "A sensitive field never goes in the event's data. The commit moves it to a separate `pii` column of the same row." | `sensitive(schema)` |
| 12.2 | `app.load(User, "user-42")` with no actor: `[REDACTED]` | "A read with no actor gets `[REDACTED]`." | `REDACTED` |
| 12.3 | `.discloses((event, actor) => actor.id === event.stream)`; the owner's load reads plaintext | "`.discloses` decides who may read it." | `.discloses`, `app.load(State, { stream, actor })` |
| 12.4 | `app.forget("user-42")`: every lock on the stream turns into a shred mark; `forgotten` fires; data stays | "`app.forget` wipes the `pii` column in place. Every read after it gets `[SHREDDED]`, even an authorized one. The log keeps everything else." | `app.forget`, `SHREDDED`, `app.on("forgotten")` |
| 12.5 | Code card: a state with sensitive events can't `.snap()` (throws at build) | "A snapshot would copy the value where forget can't reach it, so the build refuses `.snap` on such a state." | |

Doc: `guides/sensitive-data.md`. Test: `commit-pii-split.spec.ts` → "survives a refinement chained after sensitive()";
`read-gate.spec.ts` → "the gated load event drops the pii sidecar — plaintext never rides in event.pii";
`forget.spec.ts` → "happy path — wipes pii, returns the row count, emits forgotten once".

---

### 13. Closing the books · operator

**Scenario.** Ticket 4822 is done and archived; agent Ana's stream restarts from its balance.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 13.1 | `app.close([{ stream: "ticket-4822", archive }])`: the probe checks reactions are caught up | "Close first checks that no reaction still has work on the stream. A stream with pending work is skipped." | `app.close(targets)`, `CloseResult.skipped` |
| 13.2 | A `__tombstone__` guard appends on ticket-4822 | "It commits a tombstone at the stream's version. From here no writer can land." | `TOMBSTONE_EVENT` |
| 13.3 | The archive callback runs (token to the outside world) | "The archive runs while the stream is guarded." | `archive` |
| 13.4 | Every ticket-4822 cell fades out of the log; one `__tombstone__` seed appends at v0 | "Then the stream's events are deleted and one seed is left: a tombstone at version 0." | `closed` |
| 13.5 | `app.do` on ticket-4822: `StreamClosedError` | "An action on a closed stream throws `StreamClosedError`." | `StreamClosedError` |
| 13.6 | `{ stream: "agent-ana", restart: true }`: cells fade; a `__snapshot__` seed at v0 holds the final state; the next action lands v1 | "A restart seeds a snapshot of the final state instead, and the stream keeps going." | `restart: true` |

Doc: `architecture/close-cycle.md`, `concepts/event-sourcing.md#closing-the-books`. Test: `close.spec.ts` →
"should close streams and truncate events", "should skip streams with pending reactions",
"should restart streams with snapshot at version 0", "should throw StreamClosedError when writing to tombstoned stream".

---

### 14. Close policies and rolling windows · operator

**Scenario.** Tickets retire 90 days after they close; a ledger keeps 180 days of history.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 14.1 | `.autocloses({ is: ["TicketClosed"], after: { days: 90 } })` + `.archives(fn)`: an autoclose target appears, with a clock at head + 90 days | "`.autocloses` compiles to a reaction. It waits out the cooldown as a defer, then runs the same close cycle." | `.autocloses`, `.archives`, `autocloseWindow` |
| 14.2 | Due: the close runs; the stream ends as a tombstone seed | "A reopened stream is not closed: it decides on the live head." | |
| 14.3 | Ledger: `.snap(...)` + `.autocloses({ keep: { days: 180 } })`; the cells older than the cutoff and below the closest snapshot fade; the snapshot and later cells stay | "`keep` prunes, it doesn't retire. It deletes only below the closest safe snapshot, and the stream stays live. It needs `.snap`, and it is in days." | `keep` |
| 14.4 | `app.close([{ stream, before }])` by hand on a quiet stream | "The window advances on commits; a quiet stream is pruned by an explicit windowed close." | `before` |

Doc: `guides/close-policies.md`. Test: `autoclose-reaction.spec.ts` → "closes immediately on the terminal event for an `is` policy",
"evaluates the live head — a reopened stream is not closed", "an on-demand close prunes the idle stream the reaction left alone";
`libs/act-tck/src/store-tck.ts` → "deletes the prefix below the closest safe snapshot and keeps the snapshot + tail".

---

### 15. Restore, migrate and audit · operator

**Scenario.** The desk moves from one store to another, renaming an event on the way.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 15.1 | `app.restore(source, opts, sink)`: the sink log empties and refills from the source; gaps close and ids renumber densely; `created` is kept | "Restore replaces a store's contents from a source in one transaction, renumbering ids and rewriting causation to match." | `app.restore`, `CsvFile`, `ScanOptions` |
| 15.2 | `drop_snapshots`: extra snapshots vanish, each stream's first one stays | "It can compact on the way: drop snapshots (keeping a stream's first) or closed streams." | `drop_snapshots`, `drop_closed_streams` |
| 15.3 | `event_migrations: { OrderPaid: { to: "OrderPaid_v2", ... } }`: cells rename as they pass | "It can migrate events too. On the live store, events never change; a `_v2` name deprecates the old one." | `EventMigration`, `_v<n>` naming |
| 15.4 | `cache().clear()`, `app.reset` on projections | "Clearing the cache and rebuilding projections after a restore is the caller's job." | |
| 15.5 | `for await (const f of app.audit())`: findings appear next to the cells they name (a close candidate, a blocked target) | "`app.audit` walks the store and reports what an operator should act on." | `app.audit(categories?, options?)` |

Doc: `concepts/event-sourcing.md#restoring-a-store`, `architecture/event-schema-evolution.md`, `guides/auditing-a-store.md`.
Test: `restore.spec.ts` → "carries a __snapshot__ through a store-to-store restore", "delivers restored events and new commits to their reactions";
`audit.spec.ts` → "counts every snapshot of a restart candidate".

---

### 16. Scaling out: processes, wakeups and scoped Acts · operator

**Scenario.** Two processes share one Postgres store; two tenants each get their own.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 16.1 | Process A commits; without notify, process B sees it only on its next poll | "Without notify, another process sees a commit only when it polls." | `app.start_correlations(query, frequency)` |
| 16.2 | `store(new PostgresStore({ notify: true }))`: a wake signal flies to B; `notified` fires; B settles | "With a store that notifies, other processes wake at once. An instance never hears its own commits." | `store(adapter)` before `build()`, `Store.notify`, `app.on("notified")`, `withBroker` |
| 16.3 | Two logs side by side: `act()...build({ scoped: { store, cache } })` per tenant | "Several Acts in one process each get their own store and cache. One store belongs to one application." | `ActOptions.scoped` |
| 16.4 | `app.shutdown()`: in-flight drains finish, nothing starts after | "`shutdown` waits for in-flight work, up to a grace budget." | `app.shutdown` |

Doc: `architecture/cross-process-reactions.md`, `architecture/extension-points.md#scoped-ports-per-act`.
Test: `libs/act-tck/src/store-tck.ts` → "does not deliver an instance's own commits (self-filtering)";
`notify.spec.ts` → "subscribes when store has notify and reactions exist"; `scope.spec.ts` → "two Acts with their own scoped ports — no cross-talk".

---

### 17. At the edge: generated APIs and live updates · production

**Scenario.** A browser opens a ticket over HTTP and watches it change.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 17.1 | `hono(app, { actor, stream, sse })` / `trpc(...)` / `openapi(...)`: a client → route → action | "`@rotorsoft/act-http` generates routes from the registry: each action's payload in, its snapshots out, typed end to end." | `trpc`, `hono`, `openapi` |
| 17.2 | A refused action answers 409 `PRECONDITION` | "Errors map to status codes in one table: a refused action is a 409." | |
| 17.3 | After the commit, an SSE patch flies to the client | "With `sse`, each committed change reaches subscribed clients as a patch." | `BroadcastChannel` |
| 17.4 | A reaction calls the outside world through `webhook(...)` | "Delivery out of the process is a reaction too." | `webhook` |

Doc: `guides/auto-generated-api.md`, `concepts/real-time.md`, `guides/external-integration.md`.
Test: `libs/act-http/test/api/errors.spec.ts` → "maps PreconditionError to 409 + PRECONDITION";
`libs/act-http/test/typed-api.spec.ts` → "trpc(app) types", "hono(app) types".

---

### 18. Adapters and the TCK · adapter author

**Scenario.** The same log on three stores, and a new store proving it behaves.

| # | Viewer sees | Narration | API |
|---|---|---|---|
| 18.1 | The store's label switches: InMemory → Postgres → SQLite; the log is unchanged | "The store is a port. InMemory by default; Postgres and SQLite for real work. Inject one before building." | `store()`, `PostgresStore`, `SqliteStore` |
| 18.2 | A checklist runs against the log: commit across streams all or nothing, one lease per target, truncate seeds, notify self-filter | "An adapter proves the contract with the TCK: the same tests every in-tree store runs." | `runStoreTck({ name, factory, capabilities })` |
| 18.3 | `@rotorsoft/act/adapter`: the rules a store calls | "The rules a store must apply are exported for adapter authors, so every store applies them the same way." | `checkAppends`, `checkVersion`, `seedEvent` |

Doc: `guides/writing-a-store.md`, `guides/tck-conformance.md`. Test: `libs/act-tck/src/store-tck.ts`
(run by `store-tck.spec.ts` here and by act-pg and act-sqlite).

---

## Left out, and why

- **`.batch()` projection handlers, `withActor`, `correlator`, `maxSubscribedStreams`,
  `settleDebounceMs`, `onlyLanes` details, the dual-frontier ratio, the correlation lease
  and LRU:** tuning and internals; named in code cards at most.
- **`act-otel`, `act-pino`, `act-crypto`, `act-ops` idempotency, `act-diagram`, the
  inspector:** leaf packages, not framework mechanics on the log; the edge chapter names
  only act-http and the adapters.
- **Circuit breaker details** (`failureThreshold`, half-open trials): one step in chapter 8.

## Docs found inaccurate while writing

- `guides/close-policies.md`, opening section: says a closed stream throws
  `StreamClosedError` on `app.load`. It doesn't: `app.load` returns the tombstone as the
  head event (`event-sourcing.spec.ts` → "a cold load during the guard window keeps the
  tombstone check live"). Actions and `.loads` targets throw it
  (`internal/event-sourcing.ts`).
- `concepts/error-handling.md` opens with "Act defines four primary error types", then
  documents six (`ValidationError`, `PreconditionError`, `ConcurrencyError`,
  `StreamClosedError`, `StoreError`, and `NonRetryableError` in `Errors`).
- `STABILITY.md § Lifecycle events` lists seven events and leaves out `error`, which
  `concepts/event-sourcing.md` and `ActLifecycleEvents` include.
