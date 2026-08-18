# RFC 1487: the work mark on `StreamPosition`

- **Status:** draft
- **Issue:** #1487
- **Author:** Rotorsoft
- **Created:** 2026-08-16

A one-field addendum to [RFC 1486](./1486-subscription-work-set.md), fixed by building step 4 of [RFC 1449](./1449-split-store-port.md). 1486 put the work mark on the subscription row and gave it one reader, `claim`. Step 4 turns correlate into the mark's producer — and immediately produces a second reader that 1486 did not anticipate.

## Motivation

Once correlate is the producer, **a subscription's watermark stops meaning "how far this reader has seen"** and starts meaning "how far this reader has consumed *its own work*". Those used to be the same number, because `claim` served any stream whose source had an event past its watermark, so a reader was handed every event in its window and acked past the ones that produced no payloads. Under the work set it is handed only what correlate marked for it.

The difference is not academic. Take a state with ten event types and a reaction on two of them: after any event of the other eight, that reaction's subscription sits below the stream's head permanently, with nothing pending. The close-cycle safety probe — which refuses to truncate a stream while a consumer is still behind — reads that as an in-flight reader and skips the close **forever**. The recurring-timer recipe caught it: a terminal `RemindersEnded` event has no reaction, so `.autocloses({ is: "RemindersEnded" })` never reaped its stream.

The probe is asking the wrong question. It wants "does any consumer have unconsumed work below the head?", and it approximates it with "is any consumer's watermark below the head?". The mark answers the real question exactly — it is the same predicate `claim` applies — but the probe reads positions through `query_streams`, which does not carry it.

## Public surface added

One optional field on an existing exported type:

```ts
export type StreamPosition = {
  // …existing fields…
  /**
   * The stream's work mark — see `SubscribeInput.correlated_at`.
   * `at < correlated_at` is the same predicate `Store.claim` applies.
   * `undefined` means the row carries no mark yet: unknown, not "no work".
   */
  readonly correlated_at?: number;
};
```

No new method, no new column (step 3 already added it), no new capability flag. Adapters return the column they already persist; `undefined` — never `0` — when it is unset.

## Alternatives considered

- **Re-run resolution inside the close cycle.** For each lagging subscription, scan the events between its watermark and the head and ask the registry whether any resolves to it. Exact, and adds no public surface — but proving *absence* means scanning the whole range, which on a stream long enough to be worth closing is the scan the close was supposed to avoid. Close is low-cadence, so the cost is survivable; the unbounded shape is not.
- **Mark the whole fetch window instead of the resolving events.** Have correlate raise a target's mark to the last event in its source window, resolving or not. Watermarks would advance exactly as they did under the probe and no reader would need to change — but it reinstates the empty lease and no-op ack per subscription that #1446 removed, and contradicts RFC 1486's central claim that the correlated set contains only streams with work. It is also only a heuristic: it holds when the resolving and non-resolving events share a correlate window and silently fails when they don't.
- **Keep the guard as it is.** Windowed close already caps its prune at `min(at)` and degrades safely to pruning less; full close does not degrade, it skips. Doing nothing means close-the-books quietly stops working for the most ordinary reaction shape there is.
- **A new `has_work` filter on `QueryStreams`.** Same surface cost as the field, less information: a caller that wants to *report* lag (an operator dashboard, `app.audit()`) needs the value, not a boolean the store already applied.

## Stability / charter impact

**Additive, MINOR.** A new optional field on an exported type (`StreamPosition`, under adapter contracts). Existing adapters compile unchanged; one that never sets it leaves every position `undefined`, which every reader must already treat as *unknown*.

No port method is added, so the TCK change is one case in the existing `work_set` block — `subscribe({correlated_at})`, then `query_streams` returns it on the marked row and `undefined` on the unmarked one — run against InMemory, act-pg, and act-sqlite. `writing-a-store.md` gains the corresponding rule, and the close-cycle guard's new predicate gets a behavior-contract row.

## Open questions

Whether `app.audit()` and the operator dashboards should report lag against the mark rather than the head. They currently report raw watermark distance, which under the work set overstates how far behind a reader is. Not blocking — it is a reporting change, not a correctness one — and better decided with an operator's eyes on it.
