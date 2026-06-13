# ACT-1134 — `when({...})`: one factory, three pressure points

## The shape that didn't survive contact

The roadmap had three tickets behind #837: `retention(...)` for time, `terminal(...)` for domain lifecycle, `cardinality(...)` for resource cost. Three factories, each producing an `AutoclosePredicate`, each living next to the others in some `autoclose-policies/` folder. The PR descriptions were already drafted.

The first call site killed the design.

```ts
.autocloses(
  anyOf(
    retention({ days: 730 }),
    terminal("TicketResolved"),
    cardinality({ max: 10_000 })
  )
)
```

That's the real shape, because real policies stack. A ticket should close when an operator marks it resolved **or** when it's been sitting in the system for two years untouched **or** when somebody finds a way to attach 10 000 comments to a single ticket. Pick one and the others bite you in production. The three factories were never used in isolation — they were always wrapped in an `anyOf`.

So we wrote `anyOf` mentally, then realized the wrapper was the API. The factory IS the OR.

## The shape that did

```ts
import { when } from "@rotorsoft/act";

.autocloses(when({
  olderThan: { days: 730 },
  on: "TicketResolved",
  count: 10_000,
}))
```

One factory. One object literal. OR by construction. Every omitted field contributes nothing — it's not a default, it's not "match everything," it's absent. `when({})` throws at the factory call because empty is misconfiguration, not "match nothing."

The three fields are deliberate, not greedy. Every close policy a real system writes maps to one of three pressure points, and we couldn't find a fourth:

- **`olderThan`** is the time / compliance pressure. GDPR retention windows. HIPAA's six-year minimum. Abandoned drafts that age out. Session aggregates idle past N days. The common thread: the data is correct, but staleness alone makes it irrelevant or non-compliant.
- **`on`** is the domain lifecycle pressure. Orders ship and don't un-ship. Tickets resolve. Subscriptions cancel. Users delete their accounts. The aggregate has natural end states, and reaching one means no new events are expected from that stream — the events that already exist are history, and history doesn't need to stay in the hot index.
- **`count`** is the resource pressure. The stream IS active. The aggregate hasn't reached any natural end state. But somebody's chat thread is 50 000 messages long and the reducer cost is starting to dominate the action's hot path. Close, archive to cold storage, restart elsewhere — or just stop accepting new messages.

Anything beyond these three is some combination of them, or a per-stream metadata check (`tags.includes("priority")`) that doesn't generalize and belongs in the function-form fallback `.autocloses((stream, head, count) => …)`.

## Why nested `olderThan: { days }` instead of flat `olderThanDays`

`olderThanDays: 90` reads fine. The next request will be hours, the one after that will be minutes, and we'll end up with `olderThanDays`, `olderThanHours`, `olderThanMs`, and a precondition that says "exactly one of these." That's a worse API than the nested object, and the nested object costs one extra `{ … }` per call.

`olderThan: { days: 90 }` keeps the unit explicit at the call site (no second-guessing whether `90` is days or milliseconds) and leaves room to add `{ hours: 4 }` or `{ ms: 500_000 }` later without renaming anything. The cost is two extra characters per call site — not a fight worth picking.

## Why `count` and not `size` or `length`

The framework already has a term: `Store.query_stats` returns `count` per stream, the `AutoclosePredicate(stream, head, count)` parameter is literally named `count`, the `audit` module talks about "event count" in its prose. The factory field that maps to that parameter is `count`. Anything else would have been a rename.

## Why no AND

Real AND-composed policies are rare. The few we could come up with — "close only if resolved AND older than the SLA window" — usually want a custom predicate anyway, because the conditions are correlated. The `.autocloses` function-form is one line away (`.autocloses((stream, head, count) => head.name === "Resolved" && Date.now() - head.created.getTime() > SLA_MS)`). Adding `allOf` to `when` would have meant explaining when OR fires versus when AND fires, and the explanation never sounded right.

Easier: pick OR as the meaning, let AND be the function form, ship a smaller API.

## Validation as a first-class concern

Zod schema, parsed at `when({...})` call time, throws before `act().build()`. Sub-minute `olderThan` windows reject (the cycle itself ticks at 60 s by default — sub-minute windows can't be honored anyway, so failing loud at build is better than failing silent at run). Non-integer `count` rejects. Empty `on` strings reject. Empty `{}` rejects.

Same standard as `AutocloseOptionsSchema` / `SseOptionsSchema` / `OpenAPIOptionsSchema` — internal `WhenOptionsSchema` const, never re-exported; the public surface is `WhenOptions` (inferred type) and `when` (the factory). The pattern is starting to pay for itself; every new config bag in the framework drops into the same shape and reviewers stop having to relitigate "should this be Zod or `if (x < min) throw`."

## What this primitive is and isn't

It's a 90% factory. Three fields, OR semantics, one object literal at the call site. For the long tail — per-stream metadata, AND composition, "close only the streams matching this regex" — the function form `.autocloses(predicate)` stays in place, and `when({...})` is just one possible producer of the predicate that goes in there.

The win is that 90% of the close policies the framework will ever ship inside real apps now read as one declarative line. The other 10% read the same as they did before. There was no reason to make those two cases share a namespace.
