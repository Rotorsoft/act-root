# ACT-603 — the integration story: two shapes, one contract

## What this ticket actually closes

ACT-601 shipped backoff. ACT-602 shipped the `webhook` helper. ACT-604 shipped `NonRetryableError` and `unblock`. The framework had every primitive an integration story needs — except the story itself. Users were left to figure out, from first principles, when to call `webhook` from a reaction and when to forward to a bus. ACT-603 is the doc that names the shapes and the contract that makes either of them safe.

It's a docs-only ticket. The content matters more than the LoC. The hard part is articulating the dual-shape distinction in a way that operators internalize before they hit the head-of-line blocking problem in production.

## The two shapes

Every external-integration story in Act collapses to one question: *who owns delivery, drain or the bus?*

**Inline.** A reaction calls `webhook(...)` directly. Drain owns ordering, retries, backoff pacing, blocked-stream dead-letter. The reaction holds a lease for the duration of the round trip. This is the *right* shape when there's one receiver, the receiver is fast, and the round-trip stays well under `leaseMillis`. It's compact, type-safe, and observable through Act's existing lifecycle events. The wolfdesk demo from ACT-602 is the canonical example.

**Forwarded.** A reaction publishes the event to a bus (Kafka, SQS, NATS, Redpanda, …) and returns. Drain owns the publish step only; the bus owns everything downstream. This is the right shape when fan-out matters, when consumers are slow, or when the rest of the stack already runs a bus. Reactions stay small (~20 lines), and the bus's existing operational tooling takes over.

The book chapter will lean hard on the operational question — not "which is better in the abstract" but "what's the threshold where you graduate from inline to forwarded." The three signals in the doc (we keep adding receivers, drain is always behind, `leaseMillis` keeps creeping up) are the threshold. They're the kind of thing experienced operators recognize at sight, which is why naming them matters.

## The contract that makes at-least-once safe

The other half of the doc — and arguably the load-bearing half — is the receiver-side idempotency contract. At-least-once gives you re-delivery; idempotency makes re-delivery harmless. Without it, "at-least-once" in your logs becomes "actually twice" in your data.

The framework's choice of `event.id` as the auto-derived `Idempotency-Key` is worth a paragraph of its own. The event id is stable (same row, same id, forever), unique (no two events share an id), and monotonic (later commit = higher id). Hash-based keys break on payload normalization; UUIDs are unique but don't carry the monotonicity that lets a cache evict bounded windows. Act's choice is built-in dedup metadata, free.

Three cache shapes cover the deployment space:

1. **In-memory bounded LRU** — single-process receivers, short window, no operational dependency.
2. **Redis SETNX with TTL** — multi-process, hours-to-days window, Redis already in the stack.
3. **Postgres unique index** — durable, audit-trail-friendly, when Postgres is already there.

The book chapter should resist the temptation to recommend one. The right answer depends on the receiver's existing infrastructure. The framework's job is to ship the contract; the operator's job is to pick a fit.

## The TTL math nobody computes correctly the first time

A subtle point that goes wrong in production: the idempotency cache TTL must exceed the longest possible retry+backoff window. Get this wrong and dedup fails silently — the cache evicts the key before the sender finishes retrying, the duplicate request looks fresh to the receiver, the side effect runs twice.

For a typical reaction (`maxRetries: 5, backoff.exponential, baseMs: 200, maxMs: 30_000`), the cumulative window is about six seconds of backoff plus per-attempt timeouts — round to maybe a minute. Caches default to 24 hours partly because that's the "longest plausible incident window" and partly because the math is cheap to get wrong if you eyeball it. The book chapter will work through the math explicitly, then point at "use 24h unless you have a strong reason otherwise" as the production default.

## The recovery loop, finally named

Three primitives from ACT-604 — `app.blocked_streams()` to discover, `app.unblock(input)` to recover, `NonRetryableError` (and its `NonRetryableWebhookError` subclass) to signal permanent failure — compose into a complete operational loop:

1. Receiver returns 4xx. `webhook` throws `NonRetryableWebhookError`. Drain blocks the stream on first attempt.
2. `"blocked"` lifecycle event fires; alerting pages the operator.
3. Operator runs `app.blocked_streams()`, sees the stream and its error string.
4. Operator investigates, fixes the sender's request shape (or the receiver's schema).
5. Operator runs `app.unblock(["webhooks-out-customer-42"])` — or `app.unblock({ stream: "^webhooks-out-" })` if a family failed together.
6. Stream resumes from where it stopped. No replay, no duplicate webhooks for historical events.

Before ACT-604, step 5 was "run `app.reset(...)`," which would replay every historical event through `webhook` again — catastrophic for any non-idempotent receiver. The fact that we ship a separate `unblock` primitive is what makes the operational story actually work. The book chapter on operations should foreground this loop — it's the answer to "what does day-2 with Act look like for an integration."

## A runnable receiver

The ticket's AC includes a working tRPC receiver under `packages/server/`. The pattern is small (~40 lines for the cache, ~30 for the middleware) but it's the difference between a guide that handwaves "use Redis SETNX" and one that demonstrates the contract end-to-end. Operators reading the doc can point their wolfdesk sender at the receiver, watch dedup in action, and copy the middleware shape into their own stack.

The book chapter will walk through the receiver line-by-line — the TTL choice, the bounded LRU, the case-insensitive header lookup, the `BAD_REQUEST` on missing key. Each line is small; together they're the contract.

## Why this is a docs-only ticket

ACT-601, 602, 604 all shipped code. 603 ships a story. That distinction matters because it tells the reader something about Act's design ethos: the integration story isn't a feature to be built; it's a composition of primitives that already exist. The framework's job was to ship `webhook`, `backoff`, `NonRetryableError`, `unblock`, `blocked_streams`. The doc's job is to explain how to spend them.

This is also why the doc lands last in the Phase 3 sequence (601 → 602 → 603, with 604 slotting in alongside). Writing it before 604 would have left it with a documented limitation ("4xx blocks after maxRetries because we can't do better yet") that aged out within weeks. Landing it now means the doc describes the system as it actually is, not as it transitioned through.

## Connections to other chapters

- The error-handling chapter introduces backoff, blocked streams, the `"blocked"` lifecycle. ACT-603's recovery loop builds on it.
- The cross-process chapter (ACT-101 notes) covers competing consumers — the same `claim()` primitive is what makes inline delivery safe under horizontal scale-out.
- The schema-evolution chapter explains why `event.id` is a good dedup key — it's the same stable, unique identity used for replay.
- The forthcoming "operating Act" chapter pulls all three together: monitoring, recovery, capacity planning.
