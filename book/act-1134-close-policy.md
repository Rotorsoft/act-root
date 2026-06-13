# ACT-1134 — `.autocloses({...})`: the verb is the subject

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

So the wrapper was the API.

## The first reshape — `when({...})`

The first answer was to fold the three factories into one:

```ts
.autocloses(when({
  olderThan: { days: 730 },
  on: "TicketResolved",
  count: 10_000,
}))
```

One factory. One object literal. OR by construction. It read better than `anyOf(retention(...), terminal(...), cardinality(...))` by every metric — fewer characters, fewer parens, fewer factories to learn.

But `when` is generic. The framework's other top-level exports are nouns or verbs that scope themselves (`act`, `state`, `slice`, `projection`, `webhook`, `sensitive`). `when` doesn't scope — it's a conjunction, and conjunctions need context. Naming the factory `when` pre-committed a very common identifier and forced every future "when" idea in the framework into a qualified name (`reactionWhen`, `lifecycleWhen`). And the field names — `olderThan`, `on`, `count` — were nouns and prepositions instead of verbs, which meant the call site still needed the `when` prefix to scan as English.

## The second reshape — the verb is the subject

```ts
.autocloses({
  after: { days: 730 },
  is: "TicketResolved",
  reaches: 10_000,
})
```

No factory. The builder method `.autocloses` is overloaded to accept either a predicate function (for the long tail) or a declarative options object (for the 90% case). The field names are verbs that complete the predicate when chained off `.autocloses`:

- *autocloses **after** 90 days*
- *autocloses ... **is** Resolved*
- *autocloses ... **reaches** 10k events*

Three sentences. Read left to right at the call site, the policy is one English line. The verb `.autocloses` carries the subject; the fields finish the sentence. Nothing between the verb and the policy.

## The third reshape — the default was wrong

The second reshape shipped with OR semantics across the top-level fields. I argued "real policies stack OR" and pointed at the three-factory `anyOf` we just folded down. But that was overgeneralizing.

The next obvious question: *"isn't AND more common than OR?"*

Walking through cases honestly:

- *Close ticket 90 days after `Resolved`* (re-open / data retention window) — AND
- *Close order 14 days after `Delivered`* (return window) — AND
- *Close GDPR deletion request 30 days after `Requested`* (cooling-off period) — AND
- *Close session 24h after `LoggedOut`* — AND
- *Close completed/failed job 7 days after completion* — AND
- *Close cancelled subscription 90 days after `Cancelled`* (winback) — AND

These are AND. The cooldown-after-terminal pattern is the *primary* close logic for almost every state with a policy. The OR-stacked cases (close on `Resolved` OR after 2y retention) are *secondary* — defensive backstops added after an incident or as a safety net for unbounded growth.

The default should match the common case. So the third reshape: top-level fields combine with **AND**. An optional `or: {...}` block opens an alternative path for the safety-net case.

```ts
.autocloses({
  is: "TicketResolved",      // primary trigger
  after: { days: 90 },       // AND aged 90 days
  or: { reaches: 10_000 },   // OR safety net: also close at 10k regardless
})
```

Reads: *"autocloses is Resolved after 90 days, or reaches 10k."*

The policy fires when **either** the top-level AND group matches **or** any field inside `or` matches. Top-level handles the primary close logic; `or` handles the defensive backstops. Two axes for the two ways close policies appear in practice.

## Three fields, deliberate

The three fields are deliberate, not greedy. Every close policy a real system writes maps to one of three pressure points, and we couldn't find a fourth:

- **`after`** is the time / compliance pressure. GDPR retention windows. HIPAA's six-year minimum. Abandoned drafts that age out. Session aggregates idle past N days. The common thread: the data is correct, but staleness alone makes it irrelevant or non-compliant.
- **`is`** is the domain lifecycle pressure. Orders ship and don't un-ship. Tickets resolve. Subscriptions cancel. Users delete their accounts. The aggregate has natural end states, and reaching one means no new events are expected from that stream — the events that already exist are history, and history doesn't need to stay in the hot index.
- **`reaches`** is the resource pressure. The stream IS active. The aggregate hasn't reached any natural end state. But somebody's chat thread is 50 000 messages long and the reducer cost is starting to dominate the action's hot path. Close, archive to cold storage, restart elsewhere — or just stop accepting new messages.

Anything beyond these three is some combination of them, or a per-stream metadata check (`stream.startsWith("ephemeral:")`) that doesn't generalize and belongs in the function-form fallback `.autocloses((stream, head, count) => ...)`. Multi-branch policies that need different cooldowns per terminal event (*"(Resolved + 90d) OR (Cancelled + 30d)"*) also stay in function-form territory; the declarative form isn't trying to be a full predicate DSL.

## Why `after: { days }` instead of flat `afterDays`

`afterDays: 90` reads fine. The next request will be hours, the one after that will be minutes, and we'll end up with `afterDays`, `afterHours`, `afterMs`, and a precondition that says "exactly one of these." That's a worse API than the nested object, and the nested object costs one extra `{ … }` per call.

`after: { days: 90 }` keeps the unit explicit at the call site (no second-guessing whether `90` is days or milliseconds) and leaves room to add `{ hours: 4 }` or `{ ms: 500_000 }` later without renaming anything. The cost is two extra characters per call site — not a fight worth picking.

## Why `is` and not `on` or `event`

`on` was the first draft because it pairs with event-emitter vocabulary (`emitter.on(name, handler)`). But `on` describes the *trigger*, not the *match*. `is` describes the predicate directly: *"close when the head IS Resolved."* It's the same shape as English equality, and English equality is what the field does.

`event: "Resolved"` is the other natural candidate but reads as a noun phrase, not a complete sentence. `.autocloses({event: "Resolved"})` is "autocloses event Resolved" — needs a verb. `.autocloses({is: "Resolved"})` is "autocloses is Resolved" — has one.

## Why `reaches` and not `count`

The framework already names the parameter `count` in `AutoclosePredicate(stream, head, count)`, and `Store.query_stats` returns `count` per stream. Naming the field `count` would match exactly. But the field's *semantic* is the threshold, not the count itself — `reaches: 10_000` is "the count reaches 10k" — and at the call site, the verb framing wins. The internal cycle still reads `count`; the public field reads `reaches`.

## Why `or` and not `any`

`any: {...}` was the first candidate, mirroring JSON Schema's `anyOf`. But the verb-shaped fields (`after`, `is`, `reaches`) frame the call site as English, and `any` doesn't fit that frame:

> autocloses is Resolved after 90 days, **any** reaches 10k

The word `any` needs a complement — *any of what?* — and the reader has to back-fill the context.

`or` works because it's an English conjunction that ties the alternative path directly to the preceding clause:

> autocloses is Resolved after 90 days, **or** reaches 10k

That's a complete sentence. The schema reads at the same pace as the policy does at the call site. The `anyOf` precedent loses to the English readability of `or`.

## Validation as a first-class concern

Zod schema, parsed at `.autocloses({...})` call time, throws before `act().build()` completes. Sub-minute `after` windows reject (the cycle itself ticks at 60 s by default — sub-minute windows can't be honored anyway, so failing loud at build is better than failing silent at run). Non-integer `reaches` rejects. Empty `is` strings reject. Empty `{}` rejects. Empty `or: {}` rejects. Nested `or` inside `or` rejects (the `or` schema runs in strict mode, so the nested `or` key is unknown). Unknown top-level keys reject.

Same standard as `AutocloseOptionsSchema` / `SseOptionsSchema` / `OpenAPIOptionsSchema` — internal `AutoclosePolicySchema` const, never re-exported; the public surface is `AutoclosePolicy` (inferred type) and the `.autocloses({...})` overload. The pattern is starting to pay for itself; every new config bag in the framework drops into the same shape and reviewers stop having to relitigate "should this be Zod or `if (x < min) throw`."

## What this primitive is and isn't

It's a 90% form. Three fields, AND-by-default top level, `or` block for the safety-net path, one object literal at the call site, no factory to learn or import. For the long tail — per-stream metadata, multi-branch AND/OR with different cooldowns per terminal event, regex-shaped predicates — the function form `.autocloses(predicate)` stays in place, and the declarative form is just a different argument shape on the same builder method.

The win is that 90% of the close policies the framework will ever ship inside real apps now read as one declarative line. The other 10% read the same as they did before. There was no reason to make those two cases share a namespace, and there was no reason to wedge a factory between them.

The lesson the three reshapes pay for: the call site is the spec. If reading the line out loud doesn't sound like English, the API isn't done — even if the types are correct, the validation is tight, and the implementation is one function call. The factory-wrapped first draft was correct; the AND-default verb-shaped final form is *clear*. Those are not the same property.
