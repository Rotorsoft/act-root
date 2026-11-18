# Act framework tour: the script

The storyboard behind the animated tour (`docs/src/tours/framework-tour.ts`, played by
`docs/src/components/Tour`, hosted by the standalone page `docs/src/pages/tour.tsx`, at `/act-root/tour`). The subject is the framework:
what each capability does, shown as what it does to the event store. The domain is a thin
backdrop, mostly a small ticket desk cut down from `packages/wolfdesk`.

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
small icons at the left edge, and only things outside the app that call it: people (Maya,
Ana, Bo, Lee) and outside systems. A reaction calling `app.do` is the app acting on itself,
not an actor. The **drain** is drawn inside the app, under the slices, as Act's own worker:
its stages (correlate, claim, fetch, handle, ack) light as a reaction or projection walks
them, and its reads and claims go out through the store port. Workers, lanes, processes
and scoped apps sit in that component too. Read models sit under the actors.

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

## Left out, and why

- **`.batch()` projection handlers, `withActor`, `correlator`, `maxSubscribedStreams`,
  `settleDebounceMs`, `onlyLanes` details, the dual-frontier ratio, the correlation lease
  and LRU:** tuning and internals; named in code cards at most.
- **`act-otel`, `act-pino`, `act-crypto`, `act-ops` idempotency, `act-diagram`, the
  inspector:** leaf packages, not framework mechanics on the log; the edge chapter names
  only act-http and the adapters.
- **Circuit breaker details** (`failureThreshold`, half-open trials): one step in chapter 8.
