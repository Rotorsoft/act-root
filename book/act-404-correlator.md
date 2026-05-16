# ACT-404 — configurable correlation id generator

ACT-404 added `ActOptions.correlator` — a single-function delegate that mints the `meta.correlation` field on originating commits. Reactions still propagate `reactingTo.meta.correlation`. Material for the event-sourcing / observability chapter.

**The case against `randomUUID()` as a default.** Two problems with v4 UUIDs at the correlation site:

1. **Unreadable in operations.** Operators scanning logs / SQL results can't tell `f47ac10b-58cc-4372-a567-0e02b2c3d479` from any other event's correlation. Diagnosing a workflow forces a join back through causation metadata.
2. **Poor B-tree index locality.** Random 128-bit values scatter across the correlation column's index. Page splits, page bloat, low buffer-cache hit rate. Time-ordered ids cluster contemporaneous inserts on the same pages — orders-of-magnitude better insert performance on PG.

A worked example of "default to readable + index-friendly, not to library-provided cryptographic randomness." Generality is a cost — UUIDv4 is the right call when you have zero information; here we have a state, an action, and a timestamp.

When the book covers event metadata, contrast UUIDv4 vs. time-ordered formats and use this as the concrete example.

---

**The default: `{state[:4]}-{action[:4]}-{4 ms}{4 random}`.**

`coun-incr-lwxk9p3a` (18 chars).

- Prefix is human-meaningful — grep `coun-incr-…` and you're looking at originating-Counter-increment workflows.
- 4-char `Date.now() % 36^4` segment wraps every ~28 minutes — long enough that adjacent workflow events share B-tree pages; short enough to keep the id compact.
- 4-char random tail (1.68M values per ms) defeats collisions across competing-consumer workers without coordination.
- Names shorter than 4 chars are used as-is — `Tx` produces `tx-…`, not `tx00-…`.

It's a clean illustration of the "use the primitives you have" principle from the ACT-601 chapter — no DB sequence, no UUIDv7 dependency, no extra round-trip. Just `Date.now()` and `crypto.randomInt()`. Ground the discussion in concrete trade-offs (collision risk vs. id length vs. sortability) rather than handwaving.

---

**Common alternative correlator shapes apps plug in.** Worth a sidebar in the book — these aren't theoretical, they're the patterns that come up across real Act deployments:

1. **Tenant-prefixed.** Multi-tenant SaaS embeds the actor's tenant slug at the front: `tenantA-tick-open-lwxk9p3a`. Operators grep one tenant's workflows in seconds. Wolfdesk's bootstrap demonstrates this exact pattern.

2. **Trace-id propagation.** When an HTTP request carries a W3C `traceparent`, the API layer parks the trace id on the actor and the correlator returns it. One id flows from the edge to every emitted event — drop into Tempo/Honeycomb without joins.

3. **Idempotency-key bridge.** When an external caller supplies an `Idempotency-Key`, surface it on the actor and use it as the correlation. Retries from the same key collapse onto a single workflow id, making "did this run twice?" a single grouping query.

4. **Database-issued monotonic.** Shops that want hard cross-worker monotonicity call a Postgres sequence in the delegate: one extra round-trip per commit, but globally unique short numeric ids (`coun-incr-1234`). The cost they pay for the readability win.

5. **ULID / UUIDv7.** When the rest of the stack standardizes on time-ordered UUIDs, the delegate returns one — globally unique, sortable, no coordination, 26-36 chars. Drops the readable prefix.

6. **Actor-embedded.** Audit-heavy systems prepend a hash of `actor.id` so the same human's workflows cluster in the index even across tenants — useful when forensics is the primary read pattern.

The book chapter should mention 2-3 of these patterns to make the delegate concrete, but lean on the default for examples. Don't load every chapter with multi-tenant scaffolding.

---

**Close-cycle synthesizes its own context.** Close-the-books runs outside any user action, so Act passes `state: "$close"`, `action: "close"` to the delegate. Tombstone events from a close cycle carry an id minted by the same delegate as user actions — operators see consistent shapes even for system-emitted transactions.

Important for the book's chapter on close-the-books — the lifecycle event shapes carry through to the metadata too. When the close-cycle chapter covers tombstone emission, briefly note that close events share the user's correlator scheme.

---

**Reactions never call the delegate.** They inherit `reactingTo.meta.correlation`, preserving the chain. The delegate fires only at workflow origins. This is what makes `correlation` actually useful for grouping — the chain is structural, not statistical.

Worth calling out because it explains why "correlation" and "causation" are different fields with different semantics. Causation = parent event. Correlation = workflow root. Tie back to the correlation/causation chapter — these two metadata fields are easy to confuse; the way the framework treats them at minting time clarifies the distinction.
