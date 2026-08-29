# ACT-1592 — the retry budget the database spent

A consumer app running the SQLite adapter under `tsx watch` woke up one morning with three subscriptions blocked at once. The log said what the framework always says in that situation: the lease was lost on every attempt, the retry budget was spent without the handler ever reporting an error, raise `leaseMillis` and unblock. Every part of that advice was wrong for this app. The handlers ran in single-digit milliseconds against a ten-second lease, they had committed their commands successfully, and not one of them had failed. What had failed was the database. A few lines earlier in the same cycle sat a bare `SQLITE_BUSY: database is locked` from a second connection, which on a single-writer store is not an exotic event at all. A watch-mode restart overlapping the old process, a backup tool, an inspector holding the file: any of them is enough, and #1578 had already established that turning up `busy_timeout` is not the answer. So the routine, self-healing condition escalated into a permanent block, and the operator was sent off to resize a lease that had never been the constraint.

The mechanism is short enough to hold in your head. `claim` persists `retry = retry + 1` in the same statement that grants the lease, before any handler runs, and only a confirmed write-back resets the counter. When the cycle throws on its way to that write-back — a `fetch` that can't read, an `ack` the database refuses — the whole thing unwinds into the store-error catch in `drain-cycle.ts`, which hands the error to the circuit breaker and returns an empty drain. Nothing rolls the counter back. Do that four times and the stream arrives at claim with `retry` past `maxRetries`, which is precisely the signature the stuck-lease guard from #1418 was built to recognize, so it blocks before dispatching and reports the only cause it knows about. The asymmetry was sitting in plain sight in that catch: the framework *does* classify the failure as the store's, since that is the branch feeding the breaker, and yet the counter driving the block had already been incremented on the store's behalf with nothing reconciling the two.

---

**The wrong turn: roll the bump back.**

The obvious repair is to undo what `claim` did. On the catch path, issue a compensating update that decrements `retry` for every stream this cycle leased. It reads well right up until you notice what the catch path *is*. We are there because a store operation just failed. Asking the store to accept one more write, at the exact moment it is refusing writes, is asking the failure to fix itself. Under `SQLITE_BUSY` the rollback would fail alongside everything else, and the counter would stay walked up. Worse, it would fail silently inside a handler for a failure, which is where second-order bugs go to hide.

The other tempting shape is to move the increment: have `claim` grant the lease without persisting the bump, and let the cycle's own finalize write the counter when it knows the outcome. That is the honest fix, and it is also a change to the `Store` contract that every adapter and the TCK would have to follow, in service of an accounting detail. It gives up something real, too. The bump lives in `claim` because it has to survive a worker that dies mid-handler and never finalizes anything; a lease reclaimed after a timeout counts against the budget precisely because the increment was persisted up front, and that is the property keeping a stream that kills its workers from looping forever. Trading it away to fix the store-failure case would open the crash case.

**The decision: the drain keeps a ledger.**

The counter stays exactly where it is, and the drain learns to read it net of what it knows the store ate. Each `DrainController` holds a small per-lane map of claims charged to the store rather than to a handler, keyed by stream. Every claim is charged provisionally, on the assumption that it might die at the store, and the leases handed downstream carry `retry` discounted by everything still charged from previous cycles:

```ts
const charged = (charges.get(lease.stream) ?? 0) + 1;
charges.set(lease.stream, charged);
// The in-flight claim is a handler attempt until proven otherwise — only
// claims that already died at the store are refunded.
const credit = charged - 1;
```

A cycle that reaches its finalize settles the ledger. Streams the store confirmed owe nothing, because the discount has become durable in the persisted counter: a plain `ack` resets it, and a backoff's due-marked `ack` writes the discounted `retry` back. A stream that submitted nothing, which is what a handler failing with no progress looks like, keeps its earlier refunds and gives up only the claim it just spent, so a genuinely broken handler still blocks after exactly `maxRetries` attempts. A cycle that throws settles nothing, so the charge stands and the next claim refunds it. The discounted lease travels through every decision that reads `retry` — the claim-time budget check, the dispatcher's block decision, the counter a due-ack persists — which is what keeps the two guards from disagreeing about whose failure it was.

Inverting the bookkeeping this way, charging first and settling on success, is what let the fix stay inside the function it belongs to. Wrapping everything after `claim` in a try/catch would have said the same thing and re-indented a hundred and eighty lines to say it.

The ledger is process-local, like the defer schedule it sits next to. A restart forgets pending refunds and the stream falls back to the old accounting, which is worth being explicit about: the fix is never worse than what it replaced, and it does not pretend to be durable state. There is also a line in the log now when a refund applies, because an operator watching a stream get repeatedly reclaimed should be looking for the second connection, not for a handler that is behaving perfectly.

**What this teaches.** A counter is only as meaningful as the thing it is documented to count. `maxRetries` and `blockOnError` describe handler failures, and every path that increments the counter without a handler behind it quietly redefines them. The block message is the tell: when a diagnostic prescribes a remedy the operator can verify is irrelevant, the number it was reading has been measuring two different things at once. Splitting them is usually cheaper than it looks, and it does not always need to reach the database.

See `libs/act/src/internal/drain-cycle.ts` (`StoreCharges`, `discount_store_charges`, `settle_store_charges`), `libs/act/test/store-charge-refund.spec.ts`, and [#1592](https://github.com/Rotorsoft/act-root/issues/1592). The guard this one had to stop impersonating is the stuck-lease block from #1418: a lease genuinely lost every round still blocks the stream, and now that is the only way to arrive there.
