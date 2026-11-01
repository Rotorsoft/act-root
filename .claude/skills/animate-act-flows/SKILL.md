---
name: animate-act-flows
description: Generates an animated, interactive map of an Act app's flows (actors, actions, state, events, projections, reactions, timers, outside calls) from its builders, with scenarios that play every flow, then publishes it on the docs site or exports a video. Use when the user asks to animate, visualize, illustrate, demo, publish or record the flows of an Act app or package (for example "animate wolfdesk", "make a flow animation of the calculator", "publish the wolfdesk animation", "make a video of the escalation flow").
---

# Animate Act flows

Turns the builders of an Act app (Actions → {State} ← Reactions) into a one-screen swimlane map with tokens that travel along each step of a scenario, a live event stream and a live state panel. Use Act's words everywhere: **actions**, **state**, **events**, **projections**, **reactions**. Event-storming terms (command, policy, read model) appear only as a reference line in the player's "How to read" notes.

The pipeline lives in the docs package:

| Path | What it is |
|---|---|
| `docs/flows/<app>.flow.json` | The spec for one app. All app knowledge lives here. |
| `docs/flows/player.html` | The generic player. Never put app-specific code in it. |
| `docs/scripts/flows.mjs` | `build`, `render` and `video` commands. |
| `docs/flows/wolfdesk.flow.json` | Worked example that uses every spec feature. |

User-facing guide: `docs/docs/guides/flow-animations.md`. Keep it in step when the spec or the commands change.

## Steps

### 1. Extract a draft

```bash
npx tsx .claude/skills/animate-act-flows/scripts/extract.mts <app-src-dir> > <scratch>/draft.json
```

It reuses the `act-diagram` parser (the one behind `pnpm act`): states, actions with their preconditions and emitted events, reactions with the actions they invoke, and projections. The draft has nodes, edges, one state bar per state name and rough columns.

### 2. Read the source and fill what the parser misses

The parser is best-effort. Always read the slice and state files and check each of these:

- **Actions invoked inside helpers.** `app.do(...)` called from a helper function (wolfdesk's `reassign_if_due`) is not seen. Add the `reaction → action` edge.
- **Mislabeled reactions.** A `webhook(...)` handler or another factory-built handler can get a neighbor's name. Fix the label and `file`.
- **Timers.** `.defer(...)`, or a `DeferSignal` thrown in the handler, means the reaction waits. Put `"timer": true` on the `event → reaction` edge and `"badge": "⏱"` on the reaction.
- **Outside world.** Webhooks, notification services, payment providers and other calls out of the process become `external` nodes with a `reaction → external` edge.
- **Actors.** The parser has no actors. Read preconditions ("Must be the owner") and the app's API to decide who invokes which action. Add `actor` nodes with `"actor": "person"` or `"actor": "automation"` (a cron job, an importer, another system calling the API) and `actor → action` edges. Actions invoked only by reactions get no actor node. Instead, set `"as"` on the reaction to the actor name its `app.do` uses (`"ticket-timers"`, `"assign reaction"`), so the map shows it as an automation.
- **Slices (boundaries).** Draw only the boundaries the builders declare. A slice **owns** the partial states declared in its own file (their actions and events) and the reactions it declares. Every other partial it lists in `.withState(...)` is a **reference**: its reactions call those actions, but it doesn't own them. The draft sets `slice` on owned nodes and lists `owns` and `registers` per slice, naming partials by file. Replace those with the source variable names (`TicketCreation`, `TicketOperations`). Add a short `description` for each slice. A slice that declares no partial (wolfdesk's timers and webhooks) owns only its reactions. Never invent boundaries the source doesn't declare (phases, inferred contexts). Partials of the same name still merge into one state bar, even when different slices own them. Without slices, the player draws one box per state instead.
- **Schemas.** The draft fills `schema` on every action, event and state from the runtime Zod schema, one field per line with its constraints, and `invariants` on a state with its refinement messages. The player shows a state's schema as its invariants. Keep them; rerun the extractor and copy `schema` and `invariants` over when a schema changes.
- **State.** Give the state bar a `note` naming the partial states merged into it and a `description`. Actions pass through it on the way to events: that is where preconditions are checked and where events patch the state. With several states (the calculator's `Calculator`, `DigitBoard`, `CalculatorResult`), add one bar per state with a `span` over the columns of the actions that load it; each action passes through the bar above its column. A bar too narrow for its `note` drops it from the map (the detail panel still shows it).
- **Lanes, retries, targets.** Put `.withLane`, backoff and `.to(...)` targets in the node `description` (shown when a box is selected).
- One node per reaction. When two handlers share a name, keep separate ids.

### 3. Lay out the columns

Time runs left to right. Set `col` (fractions allowed) on every node except the bars (state, projections):

- With slices, lay the columns out slice by slice, in `.withSlice(...)` order. Each slice's actions, events and reactions sit in their own run of columns, and nothing from another slice may sit inside it (`flows.mjs` refuses that). Inside a slice, order by the story.
- Order actions by the life of the main entity (create, assign, work, escalate, close).
- An event sits in the column of the action that emits it.
- A reaction sits under its triggering event when that event is in the same slice (wolfdesk's `assign` under `TicketOpened`). A reaction whose trigger lives in another slice sits in its own slice's columns, and its edge crosses the boundary (wolfdesk's timers). When one event triggers two reactions in the same slice, put them half a column either side. Reactions must be at least one column apart.
- A projection bar spans the columns of the events it handles, or set `"span": [from, to]`.
- An external node goes under the reaction that calls it.

### 4. Write scenarios that cover every flow

Each scenario is one believable story, with a real-looking stream name (`"stream": "ticket-4821"`) and names for people. Together the scenarios must walk **every edge**: `flows.mjs` warns about any edge no scenario walks, and the job isn't done until that warning is gone. Also cover these when the app has them:

- **Refused actions.** Each precondition and each `throw` in an `.emit(...)` that a caller can actually hit.
- **Retries.** Reactions with `maxRetries`/`backoff`, and outside calls that can fail.
- **Blocking.** A target that runs out of retries. Say whether it is shared (a constant `.to({ target })`) and how to recover (`app.unblock`).
- **Timers that wake and do nothing.** The guard that ends a deferred chain.

Use one scenario per mechanism (happy path, reaction chain, timers, failures, refusals). Give a scenario an `initial` state when the story starts mid-life.

Each step walks one existing edge (`from`, `to`) or stands at one node (`at`):

- `say`: one or two plain sentences for the caption. `**bold**` and `` `code` `` render.
- Steps that reach an event: `data` (the fields that matter) and `patch` (the change to the state, mirroring the real `.patch(...)`; defaults to `data`). Set `patch` (`{}` when nothing shows) whenever the data fields aren't state fields, or they land in the state panel. The panel shows the scenario's `stream` first, then every other stream the scenario writes or loads, each folding its own events; a step on another stream sets `"stream"`. Set `"initials": { "<stream>": { "state": "<State>", "data": { … }, "version": n } }` on the scenario for the other streams' starting state (and the state name of a stream that's only loaded). `null` in a patch shows a cleared field.
- `wait` on a step leaving a deferred reaction ("deferred until escalateAfter").
- `action → event` with `"reject": "<reason>"`: the state refuses, nothing commits. Use the real precondition description or error message. While the token stands on the state bar, the player lists the action's `preconditions` and checks them one by one. A reason that matches one of them stops the list on that row with ✕, and the event stream and caption read `"<reason>" didn't hold`. Any other reason is a `throw` in `.emit(...)`, which runs only after every declared rule passed, so it shows as one more row after them. Keep the list in the order of the `.requires([...])` array (the extractor does; rules from the deprecated `.given([...])` come first).
- `reaction → external` with `"retries": n` and `"backoff": ["~200 ms", ...]`: fails n times, then succeeds. Add `"blocked": true` and `"target"` when it runs out instead.
- `{ "at": "<node>", "say": "...", "wait": "...", "noop": true }`: a timer that wakes and does nothing.
- `"commit": "<id>"` on consecutive `action → event` steps from one action: they are one transaction. The checks run once, every token travels at once, a bracket reads "one commit · N events · M streams", and the event stream groups them. Put the whole commit's caption on its first step. The build refuses a split commit, a commit across two actions, and a commit on a refused step.

The event stream shows each event's correlation and cause on its own: an actor's action starts a correlation, and a reaction's action inherits the correlation of the event that woke it. A scenario may set `"correlation": "<prefix>"` to name them.

The player numbers events and stream versions, folds the state, runs every `event → projection` feed when an event commits, and works out who caused each event (person or automation) from the step that invoked its action.

### 5. Preview

Save the spec as `docs/flows/<app>.flow.json`, then:

```bash
pnpm -F docs flows        # validates every spec, renders docs/static/flows/ (gitignored)
```

Fix every problem and every unwalked-edge warning. To show it in the conversation, render artifact content and publish it with the Artifact tool (`icon: "flow"`):

```bash
node docs/scripts/flows.mjs render docs/flows/<app>.flow.json <scratch>/<app>.html
```

### 6. Publish on the docs site

The docs build runs `flows.mjs build` before Docusaurus, so the page goes live at `https://rotorsoft.github.io/act-root/flows/<app>.html` and in the gallery at `/flows/index.html` on the next docs deploy. Work on a branch, commit the spec, open a PR. Link the new page from the app's example page in `docs/docs/examples/` when there is one. Never merge without the user's approval. To redeploy without another docs change, the user can run the "Deploy Docusaurus Docs" workflow by hand.

### 7. Video

```bash
pnpm -F docs flows:video <app | path/to/spec.flow.json> [--scenario n] [--out file.mp4] [--size 1920x1080] [--theme dark|light] [--speed 1]
```

It needs Chrome and ffmpeg, and runs the whole scenario in real time, so record one scenario at a time and tell the user how long it will take. Don't commit videos.

## Spec reference

```jsonc
{
  "title": "WolfDesk Ticket Flows",       // page name, 2-4 words
  "subtitle": "One sentence on what the map shows.",
  "source": "packages/wolfdesk/src",
  "colWidth": 142,                         // optional
  "lanes": [                               // top to bottom; empty lanes are dropped
    { "id": "actor", "label": "Actors" },
    { "id": "action", "label": "Actions" },
    { "id": "state", "label": "State", "sub": "load · check · patch" },
    { "id": "event", "label": "Events", "sub": "ticket stream" },
    { "id": "projection", "label": "Projections" },
    { "id": "reaction", "label": "Reactions" },
    { "id": "external", "label": "Outside world" }
  ],
  "slices": [                              // optional; one per slice() builder
    { "id": "slice:TicketCreation", "label": "TicketCreationSlice",
      "owns": ["TicketCreation"],                          // partials declared in the slice's file
      "registers": ["TicketCreation", "TicketOperations"], // everything in .withState(...)
      "file": "src/ticket-creation.ts", "line": 80, "description": "Shown when the box is selected." }
  ],
  "nodes": [
    { "id": "actor:customer", "lane": "actor", "actor": "person", "label": "Customer", "col": 1.5 },
    { "id": "action:OpenTicket", "lane": "action", "label": "OpenTicket", "col": 0,
      "preconditions": ["..."], "schema": "...", "file": "src/x.ts", "line": 12,
      "description": "Shown when the box is selected.", "slice": "slice:TicketCreation" },
    { "id": "state:Ticket", "lane": "state", "label": "Ticket", "note": "TicketCreation + TicketOperations",
      "schema": "status: \"open\" | \"closed\"\nclosedBy?: uuid", "invariants": ["A closed ticket has a closer"] },
    { "id": "reaction:autoClose", "lane": "reaction", "label": "autoClose", "col": 10, "badge": "⏱", "as": "ticket-timers", "slice": "slice:TicketTimers" },
    { "id": "proj:tickets", "lane": "projection", "label": "tickets", "note": "Drizzle table", "span": [0, 11] }
  ],
  "edges": [
    { "from": "evt:TicketOpened", "to": "reaction:autoClose", "timer": true }
  ],
  "scenarios": [
    { "title": "Timers only", "stream": "ticket-4823", "summary": "Shown before Play.",
      "initial": { "title": "VPN drops hourly" },
      "steps": [
        { "from": "reaction:autoClose", "to": "action:CloseTicket", "say": "...", "wait": "deferred until closeAfter" },
        { "from": "action:CloseTicket", "to": "evt:TicketClosed", "say": "...", "data": {}, "patch": { "closedById": "ticket-timers" } },
        { "from": "action:AddMessage", "to": "evt:MessageAdded", "say": "...", "reject": "Ticket must be open" },
        { "from": "reaction:webhook", "to": "ext:hook", "say": "...", "retries": 3, "backoff": ["~200 ms"], "blocked": true, "target": "ticket-escalation-webhooks" },
        { "at": "reaction:autoReassign", "say": "...", "wait": "deferred until reassignAfter", "noop": true },
        { "from": "action:Enroll", "to": "evt:Enrolled", "say": "One commit writes both...", "commit": "c1" },
        { "from": "action:Enroll", "to": "evt:SeatTaken", "stream": "course-c1", "commit": "c1" }
      ] }
  ]
}
```

`slice` goes on actions, events and reactions only. Actors, projections, state bars and outside-world nodes cross boundaries and belong to none.

Lane ids are fixed: `actor`, `action`, `state`, `event`, `projection`, `reaction`, `external`. URL fragments (`#s2`, `#dark`, `#embed`, `#record`, joined with `-`) are documented in the guide.

## Changing the player

`docs/flows/player.html` is generic. Fix layout or animation bugs there, never with app-specific code. After a change, run `pnpm -F docs flows` and look at `docs/static/flows/wolfdesk.html` at a desktop size and at phone width before publishing anything else. A browser window can't usually shrink to 390px: load the page in a 390px-wide iframe instead, and check that `document.documentElement.scrollWidth` equals the frame width (no sideways page scroll). Full pages keep a 0.75 minimum scale and scroll wide maps sideways; the `#embed` overview fits the whole map on wide screens.
