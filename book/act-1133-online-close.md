# ACT-1133 — Online close-the-books: a per-state predicate is the contract

## The pull from production

Event-sourced apps don't degrade by exploding — they degrade by accumulating. The events are correct. The indexes still answer queries. The replay still works. But a calendar app a year in is dragging a million-event ticket store behind every `query_stats` call, and the "list open tickets" endpoint takes 3 seconds instead of 30 ms. The fix isn't subtle: tombstone the resolved tickets, truncate the events, move on.

The framework already had the explicit primitive: `app.close({ stream, restart: false, archive })`. Operators who wrote a cron job that listed candidate streams and called close() per stream had it solved. But that's a recipe, not a feature — and it's the third or fourth time we'd heard "I built the cron job myself."

Sub #837 of the close-the-books epic (#802) decided to ship the cron job. Not as scripting glue — as a framework primitive that every state declares for itself, runs on a single background cycle, and reuses every guarantee the existing `app.close` path already has.

## Three rejected designs

The first instinct was to put a config block on the orchestrator:

```ts
act()
  .withState(Ticket)
  .build({
    close: {
      streams: { Ticket: { when: { event: "TicketResolved" } } },
    },
  });
```

That sketch lasted about ten minutes. It re-invented a DSL for what JavaScript already has — equality, comparison, boolean logic. It also forced cross-state config to live at the orchestrator level, separated from the state declaration it was about. If the spec changed and we added a `RetentionWindow` policy alongside `TerminalEvent`, the config schema would grow to match.

The second sketch shifted to a predicate function at the orchestrator level:

```ts
act()
  .withState(Ticket)
  .build({
    autocloses: (stream, head, count) => {
      if (head.event.name === "TicketResolved") return true;
      // …
    },
  });
```

Better — JS handled the policy. But the single global predicate had to demux on `head.event.name` to figure out which state the stream belonged to. Two states that both wanted terminal-event close meant a chain of `if (head.event.name === "TicketResolved") return true; if (head.event.name === "OrderShipped") return true;` and so on. The predicate's type also widened to the union of every state's events, which defeated the typed-event-union promise the rest of the builder makes.

The third sketch put a `.closes()` declarator on the state builder but encoded the policy as a discriminated union:

```ts
.closes({ kind: "terminal", event: "TicketResolved" })
.closes({ kind: "retention", windowMs: 24 * 60 * 60 * 1000 })
.closes({ kind: "cardinality", maxEvents: 10_000 })
```

That's a config object inside a builder method — same DSL problem as the first sketch, with the added cost that the framework now had to know about every policy kind that ever shipped. Adding a new kind became a charter-covered change to the builder's input type.

## Where it landed

The shape that survived is a predicate on the state builder:

```ts
state({ Ticket: ticketSchema })
  .emits({ TicketOpened, TicketResolved })
  // …
  .autocloses((stream, head, count) => head.name === "TicketResolved")
```

`autocloses` is the verb (matches `discloses` / `snap` — state-level, one per state, last-write-wins). The predicate sees the state's typed event union, so `head.name` autocompletes to `"TicketOpened" | "TicketResolved"` and typos fail at compile time. The three obvious policies — terminal event, retention window, cardinality bound — drop in as one-liners; they don't need a separate API. Composite policies are plain boolean logic.

A companion declarator `.archives(fn)` handles the side-effect side. The framework already had `CloseTarget.archive` plumbing in `run_close_cycle.ts` — `.archives` just exposes it through the state builder so policies can persist events to S3 before the tombstone lands. State-level, last-write-wins, same shape as `.autocloses`. The host owns the archiver; the framework owns the guard window and the truncate.

## Why the orchestrator runs one ticker, not N

The first cycle design had per-state controllers — one ticker per declared state, each running its own cadence. The argument was that a slow predicate on Ledger shouldn't block Session's cycle. That argument is real for the drain pipeline, where individual reactions can do long-running work; it isn't real for an autoclose predicate. Predicates are pure boolean functions. They don't do I/O. A "slow predicate" is a misconfiguration we should fix, not an architecture constraint to design around.

So the orchestrator runs one ticker. It iterates the states that declared `.autocloses(...)` in order, applies each state's predicate to each candidate stream, and batches truncate calls. The states share a single cycle cadence (`autocloseCycleMs`, default 60 s). Apps that declared no `.autocloses(...)` never even construct the controller — `_autoclose` stays `undefined`, `start_correlations()` skips the autoclose branch, and the orchestrator pays zero per-tick cost for them.

The cycle never reinvents close-the-books. It builds a list of `CloseTarget`s from predicate-eligible streams and hands them to `run_close_cycle` — the same function `Act.close(targets)` calls. Safety partition (skip streams with pending reactions), tombstone-guard (lock against concurrent writes), archive-while-guarded (run the host's archiver), atomic truncate — all the invariants of the existing close cycle apply unchanged. The only thing online close adds is "who decided to close it."

## The lifecycle hook nobody had to add

`start_correlations()` and `stop_correlations()` already existed for the correlation worker — the periodic pump that scans for new reaction subscriptions. Operators who run a long-lived Act instance call `start_correlations()` once at boot and `stop_correlations()` once at shutdown. Sub #837 piggy-backs on that contract: the autoclose controller starts and stops on the same hooks. Operators don't have a new method to remember. Apps that wired correlation already opt into autoclose for free; apps that don't run a long-lived instance (one-shot scripts, tests) never start the ticker and never see it run.

The ticker `unref()`s its Timeout the way the drain controllers' periodic workers do. A forgotten autoclose worker doesn't keep the process alive after `shutdown()` returns.

## The bit we deliberately didn't ship

Operators have asked for "close stream A only if stream B is closed." That's a cross-state coordination primitive — the kind of thing that grows into a small workflow engine. We didn't ship it. The host's policy still runs explicitly: `app.close([{stream: "A"}])` from a handler that already knew B was closed. Online close is a per-state predicate by design. The state's predicate sees only its own candidates. Compose at the host's scheduler if you need something more.

The other deliberate omission: same-second close. The cycle runs at `autocloseCycleMs` cadence; a 60 s window means a terminal event lingers up to 60 s before truncate. Apps that need same-second close call `app.close([{stream}])` from the action handler that emits the terminal event. The two paths compose — they share the same `run_close_cycle` pipeline.

## Where the cost lives

Three knobs gate the cycle: cadence, batch size, between-batch yield. The defaults — 60 s cadence, 64 candidates per truncate batch, microtask yield — fit the typical business app: hundreds of streams in flight, terminal/retention predicates, dominant Postgres workload. Cardinality predicates (which need `count: true` and trigger the full-scan path in `query_stats`) want a longer cadence; SQLite deployments want a positive `closeYieldMs` so the writer lock releases between batches. The knobs are validated at `act().build()` — misconfigured ranges throw `RangeError` synchronously instead of failing on the first cycle tick.

The expensive call per tick is `Store.query_stats({}, { count: true })`. On Postgres, it's a single index-aware scan; on SQLite, a read-lock walk. On big stores this dominates the cycle's cost. If the workload's predicates don't need `count`, slice 4 (or a follow-up) can pass `count: false` and drop to the cheap-heads path. Until then, the cycle pays for a feature operators might not be using — a real trade-off, but a paid-once-per-cycle one that doesn't show up in the hot path.

## What slice 4 ships

This essay covers the foundation: the declarators, the cycle, the controller. Three policy-factory subs land separately on the same primitive: `retention(...)` (#838), `terminal(...)` (#839), `cardinality(...)` (#840). Each compiles to the same `(stream, head, count) => boolean` shape. Operators who want their policy declarative read them as `terminal("TicketResolved")` and inherit the predicate shape; operators with custom policies inline the predicate. The factory layer is sugar; the primitive is the predicate.

The TCK doesn't grow for this — no new Store contract. The cycle composes existing `query_stats` + `truncate` + `run_close_cycle`. Adapter coverage lands as one integration test per adapter (PG, SQLite) confirming the end-to-end shape works against a real backend. The cost-and-correctness story is exercised by the unit tests against `InMemoryStore`.

## What this lets us delete later

Nothing in core gets deleted. The explicit `app.close(targets)` path stays — apps that already wired their own cron jobs keep working unchanged; same-second close stays on the explicit path; restart-with-snapshot stays on the explicit path. Online close is purely additive: a state that wants the framework to handle close declares `.autocloses(...)`; a state that doesn't, doesn't.

What we expect to delete later, outside the framework: every team's hand-rolled "scan streams, decide which to close, call close" cron job. The recipe disappears into the predicate.
