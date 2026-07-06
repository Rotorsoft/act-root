---
id: projections-to-database
title: Wiring projections to a database
sidebar_position: 2
---

# Wiring projections to a database

State is derived from events. Read models — "all tickets assigned to me", "weekly active users", "my dashboard" — are derived from those derived states. The shape of those queries doesn't fit the event log, so you build them in a SQL table that's *projected* from the event stream.

This guide covers the production pattern, end to end: a Drizzle-backed Postgres projection, transactional writes, batched replay for rebuilds, and the production wiring that keeps it warm.

## The model

A projection in Act is "an event handler that writes to external state". It has three responsibilities:

1. **Subscribe** to specific event names.
2. **Update** an external store (a table, an index, a cache, anywhere).
3. **Be replayable from scratch** — at any point you should be able to drop the read model and rebuild it by replaying every relevant event.

The framework handles the mechanics of #1 (correlation, drain, retries, blocked-stream tracking). You write the handler bodies for #2 and the structure for #3.

## A first projection

Drizzle schema (any ORM works the same way — Knex, Kysely, raw `pg`, …):

```typescript no-check
// db/schema.ts
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tickets = pgTable("tickets", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  messages: integer("messages").notNull().default(0),
  openedAt: timestamp("opened_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
});
```

Projection:

```typescript no-check
// projections/tickets.ts
import { projection } from "@rotorsoft/act";
import { eq, sql } from "drizzle-orm";
import { db, tickets } from "../db/index.js";
import {
  TicketOpened,
  TicketClosed,
  MessageAdded,
} from "../schemas/ticket.schemas.js";

export const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async function opened({ stream, data }) {
      await db
        .insert(tickets)
        .values({ id: stream, status: "open", title: data.title })
        .onConflictDoNothing();          // idempotent
    })
  .on({ TicketClosed })
    .do(async function closed({ stream, data }) {
      await db
        .update(tickets)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(tickets.id, stream));
    })
  .on({ MessageAdded })
    .do(async function messageAdded({ stream }) {
      await db
        .update(tickets)
        .set({ messages: sql`${tickets.messages} + 1` })
        .where(eq(tickets.id, stream));
    })
  .build();
```

A few patterns worth highlighting:

- **Named handlers** (`async function opened(...)`, not `async (event) => …`) — Act uses the function name as the handler key. Anonymous arrows are rejected at build time, because a stack trace pointing at `<anonymous>` deep in a drain pipeline is useless.
- **`.onConflictDoNothing()`** on the `INSERT` — projections must be **idempotent**. Replays happen: cache eviction during a rebuild, retry after a transient DB error, two workers racing on the same stream. If running the same handler twice would fail or duplicate, the projection is broken; design for at-least-once delivery.
- **The `sql` template literal for the increment** (`tickets.messages + 1` in SQL) — read-modify-write would race; the in-place SQL increment is naturally atomic.

Wire it into your app:

```typescript no-check
const app = act()
  .withState(TicketCreation)
  .withState(TicketOperations)
  .withSlice(TicketSlice)
  .withProjection(TicketProjection)
  .build();
```

## Transactions

The default handler runs each event in its own connection. For projections that need to update multiple tables atomically, pull the transaction explicitly:

```typescript no-check
.on({ OrderPlaced })
  .do(async function orderPlaced({ stream, data }) {
    await db.transaction(async (tx) => {
      await tx.insert(orders).values({ id: stream, total: data.total });
      await tx.update(stats).set({
        ordersCount: sql`${stats.ordersCount} + 1`,
        revenueCents: sql`${stats.revenueCents} + ${data.total}`,
      });
    });
  })
```

If the transaction throws, the framework's drain pipeline retries the handler (subject to `maxRetries`), and `block()`s the stream after the retry budget is exhausted. The `__streams__` row records `blocked: true` and an error message — your monitoring should listen for the `"blocked"` lifecycle event:

```typescript no-check
app.on("blocked", (blocked) => {
  for (const { stream, error, retry } of blocked) {
    logger.error({ stream, error, retry }, "projection blocked");
  }
});
```

## State projections — the list of the aggregates themselves

The most common read model is a list of the aggregates: the orders list, the tickets list — one queryable row per stream, holding attributes the state already has. Before `.of()`, building that list meant re-deriving state the framework already knows how to fold:

```typescript no-check
// the hand-rolled way: one handler per event, one write per event,
// and the folding logic duplicated from the state's reducers
const Orders = projection("orders")
  .on({ OrderPlaced })
    .do(async function inserted({ stream, data }) {
      await db.insert(orders).values({ id: stream, sku: data.sku, status: "placed" });
    })
  .on({ OrderShipped })
    .do(async function shipped({ stream }) {
      await db.update(orders).set({ status: "shipped" }).where(eq(orders.id, stream));
    })
  .build();
```

With a state projection the state *is* the projection — its `init()` and `.patch()` reducers do the folding, and the flush receives one row per stream:

```typescript no-check
const Orders = projection("orders")
  .of(Order) // every event of Order, folded through Order's own reducers
  .flush(async (rows) => {
    // rows: one per DIRTY stream — its folded state at the flush frontier
    await db
      .insert(orders)
      .values(rows.map((r) => ({ id: r.stream, ...r.state, eventId: r.id })))
      .onConflictDoUpdate({
        target: orders.id,
        set: { /* every projected column from excluded */ },
        setWhere: sql`${orders.eventId} <= excluded.event_id`,
      });
  })
  .build();
```

The `setWhere` guard is the documented flush contract: a **monotonic upsert** keyed on `stream`, ignoring writes older than what the table already holds (`id` is the max event id folded into the row). Plain converging upserts are already correct under the single-writer watermark; the guard additionally makes a rebuild racing a live worker order-safe.

Semantics worth knowing:

- **The state is the filter.** The projection consumes exactly the state's event register, so only that state's streams are folded — and every event of a folded stream reaches the reducer. There is deliberately no per-instance filter; a partial list is regular-projection territory.
- **Two deterministic knobs.** `flushEvery` (events folded between flush rounds, default 1000) and `maxCachedStates` (LRU bound on in-memory folded states, default 10000). Under pressure the evictee is flushed before it is dropped — eviction never loses folded work.
- **Snapshots compound.** On first sight of a stream the engine loads its head state through the regular `load()` path — cache and snapshots included — so with a `.snap()` predicate configured, a cold fold of a 100k-event aggregate costs the snapshot + tail read, not a full replay (the measured 557–988× cold-start reduction in [`recipes/PERFORMANCE.md`](https://github.com/Rotorsoft/act-root/blob/master/recipes/PERFORMANCE.md) applies directly to fold misses and rebuilds).
- **Write amplification tracks streams, not events.** A rebuild flushes one row per stream per round: measured on Postgres, rebuilding 100k events over 50 hot streams costs 100 row-writes instead of 100,000 — see [`libs/act-pg/PERFORMANCE.md`](https://github.com/Rotorsoft/act-root/blob/master/libs/act-pg/PERFORMANCE.md).
- **If the read model needs anything the state does not carry**, use the per-event or `.batch()` shapes below — `.of()` is intentionally just the list case.

## Batched replay for rebuilds

When you change the projection's logic — add a column, fix an aggregation, change a join — the old read model is wrong. The fix is to **rebuild from scratch**:

1. Truncate the projection's tables.
2. Reset the projection's reaction watermark with `app.reset(["tickets"])`. For multiple related projections, you can also pass a `StreamFilter` — `app.reset({ stream: "^proj-" })` rebuilds every projection whose target stream starts with `proj-` in a single call.
3. Call `app.settle()` once. The framework loops `correlate → drain` until every historical event has been replayed through the projection's handlers.

For long event streams, replaying one event per transaction is slow. Define a `.batch(handler)` and Act will call it with every event for a stream in a single pass:

```typescript no-check
export const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async function opened({ stream, data }) {
      await db.insert(tickets).values({ id: stream, ...data })
        .onConflictDoNothing();
    })
  .on({ TicketClosed })
    .do(async function closed({ stream, data }) {
      await db.update(tickets).set(data).where(eq(tickets.id, stream));
    })
  // For replay: a single transaction per stream.
  .batch(async (events, stream) => {
    await db.transaction(async (tx) => {
      for (const event of events) {
        switch (event.name) {
          case "TicketOpened":
            await tx.insert(tickets).values({ id: stream, ...event.data })
              .onConflictDoNothing();
            break;
          case "TicketClosed":
            await tx.update(tickets).set(event.data).where(eq(tickets.id, stream));
            break;
        }
      }
    });
  })
  .build();
```

When `.batch()` is defined, Act always calls it instead of the per-event `.do()` handlers — even for a single event. The `events` array is a discriminated union; `switch (event.name)` narrows both the event type and `data` shape, so a `default: never` exhaustiveness check works.

`.batch()` only works on static-target projections (`projection("target")`). Projections with dynamic resolvers stay on per-event `.do()` handlers — the routing is per-event by definition.

## The production rebuild flow

```typescript no-check
async function rebuildTicketsProjection() {
  // 1. Truncate the read model.
  await db.delete(tickets);

  // 2. Reset reaction watermarks AND arm the orchestrator's drain flag.
  //    Note: app.reset(), NOT store().reset() — the latter doesn't arm
  //    the flag, so a settled app won't pick the work up.
  await app.reset(["tickets"]);

  // 3. settle() loops correlate→drain until no progress; emits "settled".
  await new Promise<void>((resolve) => {
    app.once("settled", () => resolve());
    app.settle({ eventLimit: 1000 });
  });
}
```

On a fresh deploy where the read model schema has changed, you'd run this once. With the right `eventLimit` per cycle (1000 is a reasonable default; tune for your workload), settle drains a multi-million-event stream without blocking writes.

## Three things that bite people

1. **Reading the projection from inside an action handler.** The projection lags behind the event log by however long it takes the drain pipeline to catch up. If your action's logic depends on the projection being current, you have a race. Read state via `app.load(...)` (which always sees the current state through the snapshot/cache layer) — never via the projection.
2. **Projections that aren't idempotent.** Replays can and will happen. Every write must be expressible as `INSERT … ON CONFLICT DO UPDATE` or `UPDATE … WHERE`, never as a counter you increment by reading the previous value. The in-SQL `x + 1` pattern looks ugly until your first replay corrupts a counter and you understand why it's necessary.
3. **Forgetting the `"committed"` wiring.** In production, projections only update because something runs `correlate → drain` after each commit. The canonical wiring is `app.on("committed", () => app.settle())` at bootstrap — see [Production checklist](./production-checklist.md). Without it, you'll commit events all day and notice the projection is hours behind.

## Where to look in source

- `libs/act/src/builders/projection-builder.ts` — the `projection()` builder
- `packages/wolfdesk/src/ticket-projections.ts` — a real-world projection wired to Drizzle
- `packages/wolfdesk/src/drizzle/schema.ts` — the matching Drizzle schema
- [Architecture → Correlation and drain](../architecture/correlation-and-drain.md) — what runs underneath
