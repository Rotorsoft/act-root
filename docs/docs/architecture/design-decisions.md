---
id: design-decisions
title: Deliberate choices & non-goals
---

# Deliberate choices & non-goals

When you put Act next to the canonical event-sourcing toolkits — Axon, Marten, MassTransit, NServiceBus, Temporal, EventStoreDB — three patterns those frameworks ship as named primitives are missing here. There is no compensation stack, no upcaster chain, no exactly-once projection checkpoint. Read quickly, those look like gaps. They are not. Each one is a place where Act made a different call on purpose, because the peer pattern smuggles transactional or imperative thinking into an immutable log, and the same outcome is reachable on machinery Act already has.

This page documents the three as choices. For each: the pattern peers ship, the call Act made, why, and how you reach the same outcome. There is also one pattern that genuinely is missing — deferred messages and timers — and it is tracked as a real gap, not relitigated here as a choice. Knowing which is which is the point of the page.

## Compensation — forward recovery, not a rollback framework

The peer pattern is a saga with an undo stack. MassTransit and NServiceBus ship a courier; Temporal ships SAGA helpers. You declare the forward steps of a workflow, and alongside each one a compensating step, and when step N fails the framework walks the stack backward — undo N-1, undo N-2, down to the start. The rollback is a first-class concept the framework owns.

Act has no such primitive, and that is deliberate. A rollback stack is imperative-transaction thinking wearing a distributed-systems costume. It treats a multi-step workflow as something that can be "unwound," as if the steps had not happened. But in an event-sourced system the steps *did* happen — each one is a fact already committed to the log. The honest model is not "undo step N" but "step N failed, so now emit the fact that compensates for it." That compensating fact is just another event, and reacting to it is just another reaction. There is nothing to add to the framework because the framework already does exactly this.

So compensation on Act is forward recovery. When a step fails, you emit a compensating event, and a reaction on that event drives whatever cleanup the failure demands. Consider a reservation workflow: an order reserves inventory, then attempts payment. Payment fails. There is no stack to pop. The payment slice emits `PaymentFailed`, and a reaction releases the reservation:

```ts no-check
export const PaymentSlice = slice()
  .withState(Order)
  .withState(Reservation)

  .on("PaymentFailed")
  .do(async function release(event, _stream, app) {
    // The triggering event is threaded as `reactingTo` automatically.
    await app.do(
      "ReleaseReservation",
      {
        stream: event.data.reservationId,
        actor: { id: "saga", name: "payment compensation" },
      },
      { reason: "payment_failed" }
    );
  })
  .build();
```

`ReleaseReservation` runs through `load → reduce → commit` like any action, and produces a `ReservationReleased` event on the reservation stream. The log now reads, in order: reservation made, payment attempted, payment failed, reservation released. That is the audit trail of the compensation, captured as facts, with no separate rollback ledger to keep consistent with the events. If releasing the reservation should itself trigger more cleanup — notify the customer, return a coupon to the wallet — those are reactions on `ReservationReleased`, and the recovery composes outward the same way it composed inward.

The drain machinery gives this its failure semantics for free. The compensation reaction is an ordinary reaction, so it inherits leasing, retries, and backoff. If releasing the reservation hits a transient fault, the reaction retries on the next cycle from the same watermark; nothing is lost. If the failure is permanent — the reservation service returns a 4xx, or the reservation was already cancelled by some other path — the handler throws `NonRetryableError`, and the drain finalizer blocks that one stream on the first attempt rather than burning the retry budget. The blocked stream is then visible to `app.blocked_streams()`, and an operator resumes it with `app.unblock(...)` once the underlying problem is fixed. The compensation does not silently vanish and it does not wedge the rest of the workflow; it parks, loudly, on the stream that could not complete. See [Error handling § Non-retryable errors](../concepts/error-handling.md#non-retryable-errors) and the [Concurrency model](./concurrency-model.md) for the lease and block lifecycle this rides on.

The one thing forward recovery does not give you is automatic ordering of the undo. A rollback stack guarantees the reverse order of the forward steps; forward recovery gives you whatever order your reactions fire in. In practice this is rarely a real constraint, because compensations are usually independent (release the inventory, refund the card, void the shipment — none depends on the others), and where there is a true dependency you model it as a chain of reactions, each waiting on the event the previous one emits. The ordering you need becomes explicit in the event graph instead of implicit in a framework's unwinding loop.

## Schema evolution — versioned names for live reads, archiver transform for bulk rewrite

The peer pattern is the upcaster chain. Axon and Marten let you register a function that transforms an old payload shape into the new one transparently at read time, so a reducer only ever sees the latest version of an event. Add a field, register an upcaster that supplies its default, and every historical event appears to have always had the field. The reducer stays blissfully unaware that version 1 ever existed.

Act splits this into two mechanisms, and the split is the important part, because the two halves solve genuinely different problems and conflating them is how people get confused about what Act can do.

The first mechanism is **versioned event names**, and it solves the live-read problem. When a change is breaking — a rename, a type change, a narrowed constraint — you add a new event name with a `_v<n>` suffix, keep the old name in the registry forever, and write an explicit reducer for each version. `OrderPlaced` and `OrderPlaced_v2` both live in `.emits({...})`; both have a branch in `.patch({...})`; new actions emit `OrderPlaced_v2` while historical `OrderPlaced` events still reduce through their own branch. This is what gives you correct state on the hot read path: an event committed years ago is read back exactly as it was written, and the reducer that handles its version knows precisely which shape it is looking at. The cost is explicit and local — reducers branch on version — and that cost is the feature. Nothing is transformed behind your back, type information survives end to end because each name carries its own Zod schema, and the `_v<n>` convention does double duty as the deprecation signal that the build refuses to let you ignore. The full mechanics, including the build-time throw on emitting a deprecated version, are in [Event schema evolution](./event-schema-evolution.md).

The second mechanism is the **source-to-sink archiver**, `.archives(fn)`, and it solves the bulk-migration problem. When a stream closes, the archiver runs inside the close cycle's guard window, reads the stream's full history, and writes it wherever you send cold data — S3, a warehouse, a JSONL file, or a freshly rebuilt stream. Because the archiver is ordinary code holding the events in hand, it can transform them on the way out: read `OrderPlaced` (v1 shape), write `OrderPlaced_v2` (v2 shape), and the cold copy is uniform. That is a real A-to-B rewrite, and it is the right tool when you want the archived or rebuilt copy to carry only the new shape so a future rehydrator never has to know v1 existed.

Here is the nuance to be honest about, because it is the one place the two mechanisms get mistaken for each other. The archiver transforms on the way *out* — to cold storage, or into a rebuilt stream — not on the hot read path. It does **not** give you "reducers only ever see the latest shape" for your live store. The events still in the hot table are still in their original versions, and the reducers reading them still branch by version. Only versioned-name branching solves live reads; only the archiver solves bulk rewrite into a new home. If you want the upcaster's "reducers see one shape" property for live data, the answer on Act is that you do not get it, on purpose — you get a v1 reducer and a v2 reducer, and the explicitness is the trade. If what you actually want is to retire v1 from a system that has since closed those streams, the archiver rewrites them as it ships them cold, and the rebuilt or archived copy is single-shape.

| You want… | Mechanism | Where it acts |
|---|---|---|
| Correct state for historical events still in the live store | Versioned event names (`Foo_v2`) + a reducer branch per version | Hot read path, on every `load` / replay |
| A single-shape copy of closed streams in cold storage or a rebuilt stream | The `.archives(fn)` source-to-sink transform | On the way out, inside the close-cycle guard |

Why not just adopt upcasting and skip the split? Because the upcaster's transparency is exactly what Act declines to give the hot path. Transforming a payload at read time means the state you compute no longer corresponds, field for field, to what was committed — a bug in an upcaster is silently absorbed into "current state," and the immutable log stops being a faithful record of what the reducers actually saw. The versioned-name path keeps read-time transformation out of the picture entirely; the archiver path does transform, but only on the way to a *new* artifact, never by rewriting history in place. Neither one mutates a committed event where it lives. See [Event schema evolution § What the alternatives look like](./event-schema-evolution.md) for the longer argument against read-time upcasting and in-place migration scripts.

## Projections — idempotent by definition, watermark at-least-once

The peer pattern is the atomic checkpoint. Marten and the transactional-outbox family commit the projection write and the position checkpoint in a single database transaction, so the read model is updated exactly once: either both the row and the watermark advance, or neither does, and a crash can never leave the projection ahead of or behind its recorded position.

Act does not do this, and the reason is structural. An atomic watermark-plus-write would have to enroll your external projection store into the orchestrator's transaction boundary. The watermark lives in the store's `__streams__` rows; your projection might live in a different Postgres database, a different engine entirely, an Elasticsearch index, a Redis key, a file. Making the checkpoint atomic with the projection write means either every projection target must be the same transactional resource as the event store, or the orchestrator must run a distributed transaction across both. Both options drag exactly the coupling Act is built to avoid back into the drain pipeline. So Act makes the opposite call: the watermark is **at-least-once**, and projection handlers are required to be **idempotent**.

The contract is therefore short and absolute. A projection handler may run more than once for the same event. Replays happen on retry after a transient fault, on a worker crash between the write and the ack, on a deliberate rebuild, and on two workers briefly racing the same stream. Every write a handler makes must be safe to apply twice and produce the same result. In practice that means keying the write by something stable from the event — the event id, the stream and version, the stream name for last-writer-wins state — and expressing it as an upsert rather than a read-modify-write:

```ts no-check
export const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async function opened({ stream, data }) {
      await db
        .insert(tickets)
        .values({ id: stream, status: "open", title: data.title })
        .onConflictDoNothing();          // re-applying is a no-op
    })
  .on({ MessageAdded })
    .do(async function messageAdded({ stream }) {
      // in-SQL increment, never read-then-write — replay-safe and race-free
      await db
        .update(tickets)
        .set({ messages: sql`${tickets.messages} + 1` })
        .where(eq(tickets.id, stream));
    })
  .build();
```

The `.onConflictDoNothing()` makes the insert a no-op on replay. The trap is the counter: an increment that reads the current value and writes value-plus-one double-counts the first time a replay happens, so you push the arithmetic into SQL (`messages + 1` as an in-place update) where it is naturally atomic, or you make the increment idempotent by deriving it from event position rather than accumulating. For counters that must be exact under replay, key the increment on event id so a second application of the same event is rejected. The pattern, batched-replay variant, and the failure modes that bite people are walked end to end in [Wiring projections to a database](../guides/projections-to-database.md).

What you get for accepting idempotency as a requirement is that projections stay completely decoupled from the drain. The orchestrator never needs to know what a projection target is or whether its write committed; it only advances the watermark when the handler returns without throwing, and if it crashed before recording that, the next cycle simply re-delivers and the idempotent handler absorbs the repeat. Recovery after a crash is "replay from the last durable watermark," which is a no-op wherever the work already landed and a real write wherever it did not. There is no torn state to reconcile, because the projection never claimed to be exactly-once in the first place. The decoupling is the whole point: an at-least-once watermark plus an idempotent handler is strictly simpler to operate than a distributed checkpoint, and it is the only shape that lets a projection target be anything at all rather than only a co-transactional database.

## The one real gap — deferred messages and timers

Three of the four "missing" patterns are the choices above. The fourth is a genuine gap, and it is worth naming so the choices are not read as excuses.

Act has no scheduling, timeout, or deferred-message primitive. The classic pattern — "if no payment within thirty minutes, emit `OrderExpired`," "on the ninetieth day fire the retention sweep," a saga waiting on the *absence* of an event — has no first-class support today. Peers all ship it (Axon's `DeadlineManager`, NServiceBus and MassTransit saga timeouts, Temporal timers, EventStoreDB scheduled messages); Act's only time-driven mechanism right now is `.autocloses`, a single-purpose time-windowed sweep. This is not a deliberate non-goal the way the three above are. It is missing, the design stance for closing it is settled (model the schedule as event-sourcing-native data, fire it from the drain's existing due-time machinery, add no cron dependency), and it is tracked at [#1049](https://github.com/Rotorsoft/act-root/issues/1049). When you reach for a timer and find nothing, that is the gap — not another choice.
