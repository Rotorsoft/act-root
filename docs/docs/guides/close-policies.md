---
id: close-policies
title: Online close-the-books policies
description: Declaring per-state close policies so streams retire themselves once a cooldown elapses.
---

# Online close-the-books policies

Event-sourced streams accumulate. A ticketing app builds up resolved tickets that nobody reads anymore; a session store keeps minute-by-minute events for sessions that ended last week; an audit log rotates every 10 000 entries. The events are correct — they're just not interesting anymore, and they cost you index space, replay time, and `query_stats` latency.

The fix is to **close** stale streams: write a tombstone, truncate the events, and the stream becomes inaccessible for new commits (`StreamClosedError`) and old commits (`StreamClosedError` on `app.load`). Alongside the explicit `app.close({ stream })` primitive, this guide covers the *declarative* online version. As of [#1090](https://github.com/Rotorsoft/act-root/issues/1090) it is no longer a periodic store sweep: a state declares a close policy, and the framework compiles it into an internal reaction that rides the same drain everything else runs on, defers across the cooldown, and closes the stream the moment it qualifies.

Not every stream's lifecycle ends, though. For long-lived streams that must keep a bounded window of history — regulated retention, storage budgets — the same declaration surface offers a rolling-window variant, [`keep: { days }`](#keep--days---the-rolling-window), which prunes old history behind a snapshot while the stream stays live.

## What this guide answers

- How do I tell the framework "close this stream when X"?
- How does the close actually happen, now that there's no sweep?
- How do I keep only the last N days of history on a stream that never closes?
- How do I plug in archive (S3, cold tier, analytics warehouse) before truncate?
- What does the off-hours window do?
- Which policy fits which workload, and where do I go when the declarative form can't express the condition?

## Two declarators, one reaction

The state builder gains two chainable methods. Both are state-level (one per state, last-write-wins, same semantics as `.snap` / `.discloses`). Absent → the state opts out entirely and the orchestrator synthesizes nothing for it.

```ts no-check
import { state } from "@rotorsoft/act";
import { z } from "zod";

const TicketOpened = z.object({ title: z.string() });
const TicketResolved = z.object({ resolution: z.string() });

const Ticket = state({ Ticket: z.object({ open: z.boolean() }) })
  .init(() => ({ open: true }))
  .emits({ TicketOpened, TicketResolved })
  .patch({
    TicketOpened: () => ({ open: true }),
    TicketResolved: () => ({ open: false }),
  })
  .autocloses({ is: "TicketResolved", after: { days: 90 } })
  .archives(async (stream) => {
    await archiveToS3(stream);
  })
  .build();
```

- **`.autocloses(policy)`** decides **when**. It takes a declarative `AutoclosePolicy` object — `{ is, after, reaches, or }` for terminating a stream, plus the independent rolling-window field [`keep`](#keep--days---the-rolling-window). There is no function-predicate form (see the [migration note](#migrating-from-the-function-predicate-form) if you have one).
- **`.archives(fn)`** decides **what to persist before truncate**. Runs while the stream is guarded (no concurrent writes); a thrown archiver leaves the stream guarded but un-truncated, and the close retries on the next visit. It works whether or not `.autocloses` is declared (it also runs for explicit `app.close({ stream, archive })` calls).

Build the app and opt in to the lifecycle:

```ts no-check
import { act } from "@rotorsoft/act";

const app = act()
  .withState(Ticket)
  .build({
    // optional off-hours gate; omit to evaluate on every commit
    autocloseWindow: { start: 22, end: 6, timeZone: "America/New_York" },
  });

app.start_correlations();   // runs the drain (and therefore the autoclose reaction)
// … run the app …
await app.shutdown();
```

Apps that declare no `.autocloses(...)` synthesize no autoclose reaction — the cost of opting out is exactly the cost of not declaring it.

## The declarative `.autocloses({...})` form

Three operational pressure points cover the bulk of real workloads. `.autocloses` takes a policy object with verb-shaped fields that compose at the call site like a sentence:

```ts no-check
.autocloses({
  is: "TicketResolved",      // domain lifecycle — head event in this set
  after: { days: 90 },       // AND time — head older than 90 days
})
```

Reads: *"autocloses is Resolved after 90 days."* Top-level fields combine with **AND** — the stream closes only when every condition holds. This captures the cooldown-after-terminal pattern that runs through almost every business app (close 90 days after `Resolved`, 14 days after `Delivered`, 30 days after a GDPR deletion request). For pure-OR backstops or mixed patterns, a separate `or: {...}` block opens an alternative path (see below).

Each field is optional and contributes independently. `.autocloses({})` throws at build time because empty config is a misconfiguration, not "match nothing." Validation runs through a Zod schema with `.strict()` enabled, so out-of-range values and unknown keys both surface at `act().build()`, not on the first cycle tick.

### `after: { days }` — time / compliance

"Close once the head event is older than X."

```ts no-check
.autocloses({ after: { days: 90 } })
```

Workloads: GDPR/PII retention windows, session aggregates after N days idle, audit logs past statutory keep-window, abandoned drafts. The state may not have a terminal event but has a max-staleness budget.

`days` is a `number` (fractional accepted — `{ days: 1/24 }` is 1 hour). Resolved windows below one minute throw at build time. An `after` window is what gives the autoclose reaction a due-time to defer to: when the head is too young, the reaction parks until `head.created + the window` rather than re-checking on a blind interval.

### `is: "EventName"` — domain lifecycle

"Close once the head event reaches a designated terminal state."

```ts no-check
.autocloses({ is: "TicketResolved" })
.autocloses({ is: ["Shipped", "Delivered", "Cancelled"] })
```

Workloads: resolved tickets, completed orders, expired sessions, withdrawn applications, deleted user accounts, completed/failed jobs. Every stream has a clear "I'm done" event (or set of events); once one is the head, the stream stays inactive.

Single string for the most common case (one terminal event); `readonly string[]` for multi-terminal states (`Order: Shipped | Delivered | Cancelled`). The compiled policy matches the live `head.name` against the set; the act-builder catches typo'd event names at build time via the existing event-registry check. With no `after` companion, an `is` policy closes the moment the terminal event commits — there's nothing to wait for.

### `reaches: N` — resource

"Close once the stream has accumulated N or more events."

```ts no-check
.autocloses({ reaches: 10_000 })
```

Workloads: long-running chat threads, IoT telemetry streams, hot audit logs, event-loop counters — anything where the stream IS active but you want to rotate at a size threshold to keep reducer cost predictable.

Inclusive (`>=`) — the policy fires at the moment the threshold is reached, not after. The reaction reads the live count from `query_stats` on each visit, so a `reaches` policy re-evaluates whenever the aggregate commits another event.

### `keep: { days }` — the rolling window

"Keep exactly the last N days of real events; archive and prune everything older."

The three fields above (and the `or` block) all decide when a stream's lifecycle *ends*. `keep` is different in kind: it never terminates anything. While the stream stays open, it prunes events older than `now − keep` behind the closest safe snapshot via a **windowed close** — no tombstone, no seed, and the stream keeps accepting actions. The workload it exists for is the long-lived stream with a regulated retention window: a ledger that must keep exactly 180 days queryable as real events, an audit trail with a 7-year contract, a per-tenant activity stream with bounded storage.

```ts no-check
const Ledger = state({ Ledger: z.object({ balance: z.number() }) })
  .init(() => ({ balance: 0 }))
  .emits({ Posted: z.object({ amount: z.number() }) })
  .patch({ Posted: ({ data }, s) => ({ balance: s.balance + data.amount }) })
  .on({ post: z.object({ amount: z.number() }) })
  .emit((a) => ["Posted", { amount: a.amount }])
  .snap((s) => s.patches >= 100)          // keep requires snapshots
  .autocloses({ keep: { days: 180 } })    // prune history older than 180 days
  .archives(async (stream, _head, before) => {
    // before is set on windowed closes: archive the events older than the cutoff
    if (before) await archiveToS3(stream, before);
  })
  .build();
```

Four things to know:

**It requires `.snap(...)`, and the builder enforces it twice.** A windowed close anchors on a real snapshot the app wrote — the store deletes only the prefix below the latest `__snapshot__` older than the cutoff, so a state that never snapshots has nothing to prune behind. The `ActionBuilder` carries a type flag that `.snap()` flips: `keep` simply won't typecheck before `.snap` in the chain, and an untyped caller who sidesteps the type gets a runtime throw at build. Corollary: a stream that hasn't produced a qualifying snapshot yet is skipped that cycle (reported in `CloseResult.skipped`), and the prune retries after the next snapshot lands.

**The floor is one full day.** The close cycle is low-cadence, non-priority housekeeping — nothing on the close surface is denominated in milliseconds, seconds, or minutes. Real retention contracts are days and up (`{ days: 180 }`, `{ days: 2555 }` for 7 years); a sub-day window rejects at build.

**It is independent of the terminate fields.** `keep` participates in neither the top-level AND group nor the `or` block — declaring `keep` inside `or` rejects at build. A policy may terminate, prune, or both: `.autocloses({ is: "AccountClosed", keep: { days: 180 } })` prunes the rolling window while the account lives and full-closes when it ends, and a terminate match always takes precedence over a prune on the same visit.

**The reaction defers to the tail, not the head.** The prune decision keys on the stream's oldest *domain* event (snapshots and tombstones excluded): when it has aged past `now − keep`, the reaction stages the windowed close with `before = now − keep`; otherwise it parks until `tail.created + keep` — the exact moment the oldest surviving event ages out of the window — or the terminate cooldown's opening, whichever comes first. After a prune the tail moves forward, the next due-time moves with it, and the stream settles into a steady rhythm of one productive prune per window.

Be clear about what `keep` is *not* for. It is not a load-latency feature — events behind the latest snapshot never affect load results anyway, so pruning them makes `app.load` exactly zero faster. If your streams have lifecycles that end, the terminate fields above are the right tool; if the whole events table is too big across many streams, look at the [scaling recipes](https://github.com/Rotorsoft/act-root/tree/master/recipes/scaling) instead. `keep` earns its place when a live, never-closing stream must hold a bounded window of history — usually because a regulator or a storage budget says so. The imperative twin is `app.close([{ stream, before: cutoff }])` for one-off prunes driven by your own scheduler; the mechanics of both are in [Windowed close in the close-cycle architecture](../architecture/close-cycle.md#windowed-close--prune-behind-a-snapshot).

### Stacking — top-level AND + `or` block

Top-level fields are AND-combined. Two reasons that's the right default:

1. The **cooldown-after-terminal** pattern is universal. Close *after* `Resolved`, *after* `Delivered`, *after* a deletion request — all of these read as `is X AND after N` in English, and that's the matching semantics in the schema.
2. The conditions inside a typical primary policy are conjunctive ("the ticket must be Resolved *and* aged enough"), not disjunctive.

For pure-OR backstops or for mixing both shapes, use the optional `or: {...}` block. The policy fires when **either** the top-level AND group matches **or** any field inside `or` matches:

```ts no-check
.autocloses({
  is: "TicketResolved",         // primary close trigger
  after: { days: 90 },          // AND aged 90 days (return window)
  or: { reaches: 10_000 },      // OR cardinality safety net (close at 10k regardless)
})
```

Reads: *"autocloses is Resolved after 90 days, or reaches 10k."*

The two-axis split mirrors the two ways close policies appear in practice:

- **Primary close logic** (AND-shaped) lives at the top level — the conditions that *must all hold* for a normal close.
- **Defensive backstops** (OR-shaped) live in `or` — independent triggers that close the stream regardless of the primary state, so unbounded growth doesn't escape the policy.

Pure-OR policies (no top-level fields, only `or`) work too: `.autocloses({ or: { is: "Resolved", reaches: 10_000 } })` reads "autocloses or is Resolved or reaches 10k" — close when either alone is true. The empty top-level AND group never satisfies its own path on its own; only the `or` block can fire in that case.

The declarative form covers the bulk of real policies in one line. For the long tail — multi-branch policies with different cooldowns per terminal event (`(Resolved + 90d) OR (Cancelled + 30d)`), per-stream metadata, a saga waiting on the absence of an event — drop the policy and call `app.close` from your own logic or scheduler. See the [migration note](#migrating-from-the-function-predicate-form) for the shape.

## What runs under the hood

`.autocloses(policy)` compiles to an internal **reaction**, synthesized at `act().build()` against every event the state owns. There is no sweep and no ticker iterating the whole store. When the aggregate commits, the reaction fires and evaluates the policy against the aggregate's **live head** (read via `query_stats`, so a reopened stream re-evaluates correctly), then does one of three things:

1. **The terminate policy matches** → the reaction throws an internal close signal. The orchestrator runs the candidate through `run_close_cycle` — the same pipeline `app.close` uses — so the safety partition, tombstone guard, archive-while-guarded, and atomic truncate all apply unchanged, and a `closed` lifecycle event fires with the `CloseResult`.
2. **A `keep` window is declared and the oldest domain event has aged out** → the reaction stages a *windowed* close with `before = now − keep`: the store prunes the prefix behind the closest safe snapshot (capped at the laggiest consumer's watermark), the stream stays live, and the windowed entry rides the same `closed` lifecycle event with its `before` echoed.
3. **Neither fires but a due-time is derivable** (`after` cooldown, `keep` window, or both) → the reaction *defers* to the earliest of `head.created + after` and `tail.created + keep`. The drain holds the event pending without advancing the watermark or bumping `retry`, persists the due-time in the store, and re-delivers when it passes. The deferral is durable shared state — every competing worker honors it — with a per-worker timer layered on top to wake the local worker promptly.
4. **No due-time is derivable** (`is` / `reaches` only) → the reaction acks and waits for the next event on the aggregate to re-trigger.

Critically, the autoclose reaction runs on a **synthetic per-aggregate stream** (`__autoclose__:<stream>`) so its lease and deferrals never interfere with the aggregate's own reactions. For the full state machine, see [Online close-the-books in the close-cycle architecture](../architecture/close-cycle.md#online-close-the-books).

### Off-hours window

`autocloseWindow: { start, end, timeZone? }` keeps closes out of peak traffic. When the autoclose reaction fires outside the window, it defers to the next cycle instead of closing. Hours are integers in `[0, 23]`, evaluated in `timeZone` (an IANA string, default `"UTC"`, DST-correct via `Intl`):

```ts no-check
.build({
  autocloseWindow: { start: 22, end: 6, timeZone: "America/New_York" },
})
```

`start > end` is an overnight window (the example above runs 22:00–06:00). `start === end` is rejected at build. Omit the window to evaluate on every commit. A reaction that triggers outside the window parks until the exact instant the window next opens — derived from the window itself, DST-correct, no polling cadence to configure. (`autocloseCycleMinutes` used to pace this re-check; since #1175 it is deprecated and ignored.)

## The archive contract

On a full close, `.archives(fn)` runs **inside the close cycle's guard window** — the same window the explicit `app.close({ stream, archive })` uses. The cycle:

1. Commits a tombstone marker with `expectedVersion`, locking the stream against concurrent writes.
2. Runs the archiver (`await fn(stream, head)`).
3. On success → truncates the events.
4. On thrown archiver → leaves the stream guarded but un-truncated. No events are lost; the close retries the candidate on the next visit (which may succeed once the host fixes whatever broke).

On a **windowed** close staged by a `keep` policy, the archiver receives the cutoff as a third argument — `fn(stream, head, before)` — and there is no tombstone guard against appends: the pre-cutoff prefix is immutable (the cutoff is in the past, so concurrent appends land above the boundary), so the archiver reads stable history while the stream keeps committing. Archive the events older than `before`; the prune deletes a subset of them (only the prefix below the boundary snapshot), so archive plus the live stream always adds up to full history. A thrown archiver aborts the prune the same way — nothing deleted, retried on the next visit. On full closes the third argument is absent, which is how one archiver serves both paths. Two windowed closers for the same stream — a manual `app.close({ before })` racing the `keep` policy's autoclose prune — are serialized by a per-stream lock ([#1222](https://github.com/Rotorsoft/act-root/issues/1222)), so the archiver fires at most once per pruned range: the second closer sees the already-pruned prefix and skips.

The host is responsible for:

- **Idempotency.** A second archiver invocation on the same stream (after a previous attempt failed) must not re-add the same data to the destination. Most archivers achieve this via the stream name as the destination key (`s3.upload("tickets/" + stream, …)` overwrites the same key on retry).
- **Speed.** The archiver holds the stream's guard the whole time it runs. A 10-second archiver delays the truncate by 10 seconds. Stage the heavy work to a queue if needed and let the archiver finish in a hundred milliseconds.
- **Storage durability.** The framework doesn't check whether the data made it to S3 — it only knows the archiver resolved. If the archiver acks early ("I queued the write, S3 ack TBD"), the framework will happily truncate before the queue drains.

## What this primitive is NOT for

- **Restart** (rotating a stream while keeping the entity alive). The terminate fields always tombstone. Rotation stays on the explicit `app.close({ stream, restart: true })` path. (`keep` is the different case: it prunes a live stream's history but is neither a rotation nor a restart — no seed is ever written.)
- **Cross-state coordination** ("close stream A only if B is closed"). Each state's policy sees only its own aggregate's head. Compose in the host's scheduler if you need it.
- **Arbitrary conditions.** The declarative policy derives a due-time and a terminal set; conditions it can't express belong in your own logic calling `app.close`.
- **Load latency.** Pruning with `keep` never speeds up `app.load` — replay is snapshot-anchored, so pre-snapshot events already contribute nothing to any load result. If loads feel slow, tune `.snap` cadence instead.

## Migrating from the function-predicate form

Earlier releases let `.autocloses` take a `(stream, head, count) => boolean` function. That form is **removed** as of [#1090](https://github.com/Rotorsoft/act-root/issues/1090): an opaque predicate has no derivable due-time to defer to and no terminal event to react against, so it cannot be compiled into the reaction that replaced the sweep. Calling `.autocloses(fn)` now throws at `act().build()` with a migration message.

Most function predicates were just a declarative policy written the long way:

```ts no-check
// Before — function predicate
.autocloses((_stream, head) => head.name === "TicketResolved")

// After — declarative policy
.autocloses({ is: "TicketResolved" })
```

```ts no-check
// Before — terminal + cooldown by hand
.autocloses((_stream, head) =>
  head.name === "TicketResolved" &&
  Date.now() - head.created.getTime() >= 90 * 86_400_000
)

// After
.autocloses({ is: "TicketResolved", after: { days: 90 } })
```

For conditions the policy genuinely can't express — different cooldowns per terminal event, per-stream metadata, anything reading outside the head/count — move the decision into your own logic and call `app.close` explicitly:

```ts no-check
// (Resolved + 90d) OR (Cancelled + 30d): different cooldowns per terminal.
// Drive it from your own scheduler / a reaction that calls app.close.
const ninetyDays = 90 * 86_400_000;
const thirtyDays = 30 * 86_400_000;

async function retireOldTickets(app, store) {
  const stats = await store().query_stats({ stream: "^ticket-" });
  const now = Date.now();
  const toClose: { stream: string }[] = [];
  for (const [stream, { head }] of stats) {
    const age = now - head.created.getTime();
    if (head.name === "Resolved" && age >= ninetyDays) toClose.push({ stream });
    else if (head.name === "Cancelled" && age >= thirtyDays) toClose.push({ stream });
  }
  if (toClose.length) await app.close(toClose);
}
```

## Pointers

- `.autocloses` / `.archives` declarators: `libs/act/src/builders/state-builder.ts`
- Declarative policy schema + compiler: `libs/act/src/internal/autoclose-policy.ts`
- Reaction synthesis + signals: `libs/act/src/act.ts`, `libs/act/src/internal/{defer-signal,close-signal,defer-timer}.ts`
- [Close-cycle architecture](../architecture/close-cycle.md) — explicit close + the synthesized autoclose reaction in one page
- [Error handling](../concepts/error-handling.md) — what `StreamClosedError` means for actions on a closed stream
