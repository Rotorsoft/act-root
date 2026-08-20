# RFC 1527: `Store.retire` — take subscription removal out of `truncate`

- **Status:** draft
- **Issue:** [#1527](https://github.com/Rotorsoft/act-root/issues/1527)
- **Author:** Rotorsoft
- **Created:** 2026-08-20

## Motivation

Retiring a stream has to do two things: delete its events, and forget its
subscription. Today `Store.truncate` must do both, in one transaction.

That is fine when both live in the same database. It stops being possible when
they do not. The [hybrid-store recipe](../recipes/scaling/hybrid-store/README.md)
puts the event log on one system and the subscriptions on another, and every
other method in that recipe is a one-line delegation — `commit` goes left,
`claim` goes right. `truncate` is the only one that cannot be, because the port
demands atomicity across the boundary and there is no shared transaction to get
it from.

So the recipe does what every hybrid adapter will have to do: call the two
halves in sequence, pick an order, and accept a crash window. The order is not
obvious, and getting it wrong fails silently rather than loudly:

- Log first commits the tombstone that stops new events landing. A crash
  afterwards orphans a subscription row, which claims nothing and is reaped by
  the next close of that stream.
- Subscriptions first leaves a live stream with no subscription. Delivery stops,
  nothing errors, and nothing heals it.

That reasoning currently lives in a recipe comment. Every adapter author has to
re-derive it, and the failure mode for getting it backwards is silent. It is
framework work pushed into userland.

There is also no way to opt out. Nothing else on the port retires a
subscription — `reset` rewinds a watermark, `unblock` clears a flag — so an
adapter cannot delegate step 2 to the orchestrator even though the orchestrator
is already sequencing the close.

## Public surface added

- **Port methods** — one new **capability-gated** (optional) method on `Store`:

  ```ts
  retire?: (streams: string[]) => Promise<number>;
  ```

  Removes the subscription rows for fully-retired streams. Returns how many rows
  were removed. Idempotent: retiring a stream with no subscription row is a
  no-op returning 0.

- **Exports** — none.
- **Builder methods** — none.
- **Lifecycle events** — none.
- **Types** — no new exported type; `retire` is a member of the existing `Store`
  interface, and `StoreCapabilities` (already exported from `@rotorsoft/act-tck`)
  gains a `retire?: boolean` flag.

`Store.truncate`'s **documented contract** changes from "removes the stream's
entry from the streams table" to "removes it, or leaves it to `retire`". No
signature changes and no existing behaviour becomes invalid.

## Design

The orchestrator already knows which streams were fully retired. `Act.close`
computes exactly that set today, to tell the correlate cycle to forget them
(#1398):

```ts
const retired = [...result.truncated.entries()]
  .filter(([, r]) => r.committed.name === TOMBSTONE_EVENT)
  .map(([stream]) => stream);
```

A stream seeded with a tombstone was retired; one seeded with a snapshot was
restarted and keeps its subscription. So the change is to call `retire` with
that same set, after the truncate has succeeded:

```ts
if (retired.length) {
  this._correlate.forget_subscribed(retired);
  await store().retire?.(retired);
}
```

**Order is fixed by the orchestrator, once.** Log first, subscriptions second —
the same order the recipe derives by hand, for the same reason, now in one place
that every adapter inherits. `Act.close` is already resumable after an
interrupted truncate (#1389), which is what makes the window between the two
steps recoverable rather than merely rare.

**Existing adapters do not change behaviour.** Their `truncate` keeps removing
the row inside its transaction, and the follow-up `retire` deletes nothing and
returns 0. That is one extra indexed delete per closed stream, on the close
path, which is low-cadence housekeeping by design.

**A hybrid adapter delegates `truncate` to the log half and implements
`retire` against the subscription half.** That is the entire point: the last
method that forced an adapter author to reason about distributed transactions
becomes two ordinary delegations.

## Alternatives considered

**Make `truncate` stop removing the row, and require `retire`.** Cleaner, and
where this probably ends up in 2.0. Rejected for now because `truncate` is a
published contract: a caller invoking `store().truncate(...)` directly — outside
`Act.close` — would silently start leaking subscription rows. That is a
behaviour change to charter-covered surface, so it needs a major bump. The
optional method gets the capability into 1.x without one.

**Let each adapter keep solving it, and just document the ordering.** This is
the status quo plus a doc. Rejected: the argument is subtle, the wrong answer is
silent, and every hybrid re-derives it. The orchestrator already sequences and
resumes close phases, so it is the natural owner.

**Add a general `Store.unsubscribe(streams)` instead.** A broader verb invites
callers to remove subscriptions outside a close, which is not a supported
operation — a live stream with no subscription silently stops delivering.
`retire` is deliberately named for the one situation where removal is correct,
and the orchestrator is its only caller.

**Give `truncate` a flag (`retire_subscriptions: false`).** Keeps one method but
splits its contract by argument, so the atomicity guarantee becomes conditional
on a parameter. Harder to describe and harder to test than a separate method.

## Stability impact

**Additive, MINOR.** `retire` is optional, so every existing adapter — in-tree
and third-party — continues to satisfy `Store` untouched. The orchestrator
calls it through `?.`, so an adapter that omits it behaves exactly as today.

The TCK gains a `retire` suite gated on `capabilities.retire`, following the
`restore` precedent, so adapters opt in when they implement it.

The one non-additive edge: an adapter that implements `retire` **and** removes
the row in `truncate` gets both. That is idempotent by construction, which the
TCK asserts.

## Testing

- TCK: `retire` removes the row; returns the count; is idempotent on a stream
  with no row; is a no-op on an empty list; leaves other streams alone.
- TCK: retiring a stream does not delete its events (it is the subscription
  side only).
- `act` unit: `close` calls `retire` with exactly the tombstoned streams, and
  not with restarted ones.
- `act` unit: `close` against a store without `retire` behaves as today.
- All three in-tree adapters implement it and run the suite.
