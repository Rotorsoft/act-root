# ACT-639 — `query_stats` and the cost of conflating concerns

ACT-639 added `Store.query_stats(input, options)` and migrated the two callsites it was motivated by: the close-cycle's per-stream head scan and the inspector's streams page. Worth keeping a note on it not because the primitive itself is clever, but because the design walked through three wrong turns on the way to the small thing that shipped. Each rejection captures a separate API-design rule that's easy to forget once the diff is merged.

---

**The pain that started it.**

The close cycle has to know, per target stream, what the latest non-tombstone event is. That's a `Store.query` call with `backward: true, limit: 1` per stream. The first implementation ran them in parallel with `Promise.all`, so wall time looked fine — one round trip's worth, give or take. The database told a different story: N index lookups, N transactions, N rows over the wire. A 1000-stream bookkeeping rollover paid 1000 transaction-setup costs to retrieve 1000 rows the database could have produced in one indexed sweep.

The inspector's streams page was the worse case. Same operational shape — per-stream metadata for a table view — but implemented by loading every event in the store and folding into a Map on the client. For a million-event store across ten thousand streams, that's a million rows over the wire to compute ten thousand summary rows. The wrong shape squared.

The pattern under both: K result rows wanted, N source rows touched, no primitive in the framework that knew how to do that without one round trip per target.

---

**The first wrong turn: a narrow `query_heads`.**

The ticket as filed proposed `query_heads(streams, { exclude })` — the latest event per stream, that's it. Tightly scoped, easy to ship, replaces the close-cycle loop without touching anything else.

But scoping the primitive to the close-cycle ignored the inspector. Its streams page wants more than the head per stream; it wants the event count, which is full-scan work. Adding a sibling `query_counts` later would mean two primitives where one would do, plus a wrong call to `Promise.all` somewhere downstream that wanted both and didn't know it was buying two scans.

The teachable thing: when shipping a primitive to replace a specific callsite, look at the *other* callsites the primitive would unlock. Most of them are already there, written in some inferior shape. They become the second draft of the API.

---

**The second wrong turn: an always-everything `query_stats`.**

Folding head + tail + count + names into a single always-returns-all method got rid of the sibling-primitive concern. One method, one round trip, all the per-stream summary information any caller could want.

It also conflated two cost classes. The head per stream is an indexed seek; on Postgres with `DISTINCT ON (stream)` over the existing `(stream, version)` unique index, it's essentially free. Count and `name → count` aggregation require touching every event in the matched streams. The two cost curves don't even share an order of magnitude.

If the primitive always returned everything, the close-cycle — which only wants heads — would pay full-scan cost on every bulk close. That's the original problem in reverse: instead of N round trips for one row each, one round trip for N rows. The wall time would be better, the database load worse.

The shape that shipped: head always, the rest opt-in. The default call is the cheap call. The expensive flags pull in their cost honestly. A reader of the call site sees `query_stats(streams, { count: true, names: true })` and knows they asked for a full scan; the bare `query_stats(streams)` is by inspection cheap. The cost model is in the API, not buried in a JSDoc paragraph that some future caller won't read.

This is the rule worth lifting into the book chapter on framework API design: when two costs live behind one method, opt-in the expensive one. Default-cheap with opt-in expensive is more honest than always-expensive with a comment that says "this is fine for most callers."

---

**The third wrong turn: reusing `StreamFilter` for the filter form.**

The filter input wanted to support pattern-based selection (`{stream: "^orders-"}`) for callers that didn't have an explicit list. `StreamFilter` already existed for exactly that, used by `reset`, `unblock`, and `prioritize`. Reusing it gave `source` and `blocked` for free.

For free, except that those fields describe subscriptions, not events. A stream with events doesn't necessarily have a subscription. When the filter set `blocked: true`, the implementation joined event-table data against the subscription table and silently dropped any event stream that wasn't registered as a subscription. The API said "stats" — implying events — but the filter behavior bled into subscription-land.

The bug shape: `query_stats({stream: "^orders-", blocked: false})` returned fewer streams than `query_stats({stream: "^orders-"})`, not because some were blocked, but because some weren't subscribed at all. The surprise lives a long way from the call site. By the time an operator notices that some streams are missing from a report, the cause is invisible.

The fix narrowed the filter to event-level selection only — `{stream, stream_exact}`. Anyone who wants subscription-level filtering composes two calls: `query_streams({blocked: true})` to get the names, then `query_stats(names)` to get the stats. One extra round trip in exchange for a primitive that doesn't lie about what it does.

The teachable thing here is harder to write down. It's not "don't reuse types" — that's wrong, reuse is good. It's something like "reuse a type when it shares its semantics, not when it shares its shape." `StreamFilter` looked right because it had a `stream` field. It was actually wrong because the rest of the fields lived in a different domain. The type system can't catch that; only the question "does each field mean the same thing here as in its original home?" can.

---

**What ships looks small from the outside.**

A six-field options bag, one new method on the Store port, three adapter implementations, two migrations. The PR is large because it touches benchmarks and TCK and inspector and CLAUDE.md, but the primitive itself is tiny.

That smallness is the result of throwing out three larger designs along the way. The narrow `query_heads` would have been a working primitive that closed off the room for the inspector migration. The always-everything `query_stats` would have shipped a primitive that paid for what most callers didn't ask for. The wide filter form would have shipped a primitive that conflated two domains and only surfaced the bug under specific filter combinations.

When the book chapter on primitive design wants a worked example, this one is small enough to fit on a page and has enough rejected designs to make the rule visible. Three different "the obvious answer didn't fit" moments, three different rules they tested. That's the shape.

---

**Connections to other chapters.**

- The error-handling chapter (#735 ACT-604) made non-retryable a type-level signal; this one makes cost a type-level signal. Both share the underlying move of pushing operational meaning into the API surface where callers can't avoid it.
- The external-integration chapter (#689 ACT-603) chose `event.id` as the idempotency key because it was stable, unique, monotonic. `query_stats` uses the same `(stream, version)` index for its cheap path because monotonic-per-stream gives `DISTINCT ON` an index-only path. The two land in different places but both rely on the same monotonicity property.
- The inspector / operational-tooling chapter has the composition pattern as its centerpiece: `query_streams({blocked: true})` → names → `query_stats(names)`. Use this when the chapter introduces the two-call pattern; the conflated filter design is the cautionary tale.
- The performance chapter has a clean before/after for the close-cycle migration (37× faster at N=1000 on InMemory, 6.55× on PG). Use it as a worked example of "the wrong shape was the round-trip count, not the wall time."
