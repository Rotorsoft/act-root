# @act/wolfdesk

A larger Act example — a help-desk ticketing system adapted from *Learning Domain-Driven Design* (Vlad Khononov). Wolfdesk shows how to compose a single aggregate from multiple **partial states** and **slices** (vertical slice architecture), with a Drizzle/SQLite read model, periodic background jobs, and a PostgreSQL event store.

> Workspace package, not published. Run via `pnpm dev:wolfdesk` from the monorepo root.

## What it demonstrates

- **One aggregate, three slices** — `Ticket` is built from three partial states (creation, messaging, operations), each owning its own actions, events, patches, and reactions
- **Slice merging** — different slices register patches for shared events; conflicts are detected at build time
- **Per-slice reactions**:
  - `TicketCreationSlice` — on `TicketOpened`, auto-assigns an agent
  - `TicketMessagingSlice` — on `MessageAdded`, calls `deliverMessage()` then dispatches `MarkMessageDelivered`
  - `TicketOpsSlice` — on `TicketEscalationRequested`, dispatches `EscalateTicket`
- **Standalone projection** — `TicketProjection` writes a denormalized read model into a Drizzle/SQLite `tickets` table
- **Background jobs** — `AutoEscalate`, `AutoClose`, `AutoReassign` query the read model on intervals and dispatch corresponding actions
- **Invariants shared across slices** — `mustBeOpen`, `mustBeUser`, `mustBeUserOrAgent`
- **Correlation tracing** — the demo prints causation chains across reactions
- **PostgreSQL event store** — uses `@rotorsoft/act-pg` for events, SQLite (libSQL via Drizzle) for the read model

## Quickstart

```bash
# Boot Postgres for the event store (from the monorepo root, if a docker-compose.yml is provided)
docker-compose up -d

# Generate + run the SQLite migration for the read model and start the demo
pnpm dev:wolfdesk
```

The `dev` script runs migrations first, then `tsx watch src/main.ts`. The demo:

1. Resets the `act.wolfdesk` Postgres event store and the SQLite `tickets` table
2. Starts the periodic jobs (escalate / close / reassign) and the correlation pump
3. Opens a ticket, assigns an agent, adds two messages
4. Prints the projection table after every drain (`app.on("acked", ...)`)
5. Finally prints all events for the ticket grouped by correlation ID, indented by causation depth

## Layout

```
packages/wolfdesk/
├── src/
│   ├── ticket.ts                # Re-exports the three slices, invariants, and projection
│   ├── ticket-creation.ts       # TicketCreation partial + TicketCreationSlice (Open / Close / Resolve + auto-assign reaction)
│   ├── ticket-messaging.ts      # TicketMessaging partial + TicketMessagingSlice (Add/Deliver/Ack + delivery reaction)
│   ├── ticket-operations.ts     # TicketOperations partial + TicketOpsSlice (Assign / Escalate / Reassign + escalate reaction)
│   ├── ticket-invariants.ts     # mustBeOpen, mustBeUser, mustBeUserOrAgent
│   ├── ticket-projections.ts    # TicketProjection — Drizzle/SQLite read model updater
│   ├── bootstrap.ts             # Composes act() with the three slices + the projection
│   ├── jobs.ts                  # AutoEscalate / AutoClose / AutoReassign timers
│   ├── errors.ts                # Domain errors
│   ├── main.ts                  # Demo entrypoint
│   ├── schemas/                 # Zod schemas (events, actions, partial state shapes)
│   ├── services/                # External integrations (agent assignment, notifications)
│   └── drizzle/                 # SQLite schema + migrations + db client
├── drizzle.config.ts            # drizzle-kit config (sqlite, file:local.db)
└── test/
    ├── actions.ts               # Helpers for action dispatch in tests
    ├── ticket.spec.ts           # Single-ticket happy paths
    ├── tickets.spec.ts          # Multi-ticket scenarios + projection asserts + jobs
    └── invariants.spec.ts       # Invariant + error coverage
```

## Vertical slice architecture

A single `Ticket` aggregate is composed from three partial states that share a stream. Each slice owns its own actions, events, patches, and reactions:

```ts
// bootstrap.ts
export const app = act()
  .withSlice(TicketCreationSlice)   // TicketOpened, TicketClosed, TicketResolved
  .withSlice(TicketMessagingSlice)  // MessageAdded, MessageDelivered, MessageRead
  .withSlice(TicketOpsSlice)        // TicketAssigned, TicketEscalationRequested, TicketEscalated, TicketReassigned
  .withProjection(TicketProjection) // Standalone — listens across all three slices
  .build();
```

The framework merges the partials at build time. Each event is written by exactly one slice (the one that owns its custom patch) — re-declared events from sibling slices use the passthrough default and yield to the owning patch. Conflicting patches for the same event throw at build.

### Per-slice reactions

| Slice                 | Trigger                       | Reaction                                                |
|-----------------------|-------------------------------|---------------------------------------------------------|
| `TicketCreationSlice` | `TicketOpened`                | `assignAgent(...)` → `app.do("AssignTicket", ...)`      |
| `TicketMessagingSlice`| `MessageAdded`                | `deliverMessage(...)` → `app.do("MarkMessageDelivered", ...)` |
| `TicketOpsSlice`      | `TicketEscalationRequested`   | `app.do("EscalateTicket", ...)`                         |

Each reaction dispatches a follow-up action on the same ticket stream. None pass `reactingTo` explicitly — the framework injects the triggering event automatically, so the projection (and the demo's correlation print-out) sees a clean causation chain.

## Read model — `TicketProjection`

A standalone projection (registered at the `act()` level, not embedded in any slice) keeps a denormalized `tickets` row up to date:

```ts
export const TicketProjection = projection("tickets")
  .on({ TicketOpened }).do(async ({ stream, data }) => { /* insert */ })
  .on({ MessageAdded }).do(async ({ stream }) => { /* messages += 1 */ })
  .on({ TicketAssigned }).do(async ({ stream, data }) => { /* update */ })
  .on({ TicketEscalated }).do(...)
  .on({ TicketReassigned }).do(...)
  .on({ TicketClosed }).do(...)
  .on({ TicketResolved }).do(...)
  .build();
```

The read model lives in SQLite (libSQL via Drizzle):

| Column                 | Type    | Source event                              |
|------------------------|---------|-------------------------------------------|
| `id` (pk)              | text    | stream id                                 |
| `product_id`, `support_category_id`, `priority`, `title`, `user_id` | text | `TicketOpened` |
| `messages`             | int     | incremented on `MessageAdded`             |
| `agent_id`             | text    | `TicketAssigned` / `TicketReassigned`     |
| `escalation_id`        | text    | `TicketEscalated`                         |
| `resolved_by_id`, `closed_by_id` | text | `TicketResolved` / `TicketClosed`     |
| `reassign_after`, `escalate_after`, `close_after` | int (epoch ms) | written by assigns / opens |

## Periodic jobs

`src/jobs.ts` defines three timers that drive the ticket lifecycle from the read model:

| Job              | Interval | Query                                                   | Action            |
|------------------|----------|---------------------------------------------------------|-------------------|
| `AutoEscalate`   | 10s      | `escalate_after < now()`                                | `EscalateTicket`  |
| `AutoReassign`   | 10s      | `closed_by_id IS NULL AND reassign_after < now()`       | `ReassignTicket`  |
| `AutoClose`      | 15s      | `close_after < now()`                                   | `CloseTicket`     |

Each timer reads from the SQLite projection (cheap) and dispatches actions to the Postgres-backed aggregate.

## Database setup

### Event store — PostgreSQL

`src/main.ts` configures `PostgresStore({ port: 5431, schema: "act", table: "wolfdesk" })`. Boot a Postgres on port 5431 (the project's `docker-compose.yml`, if present) before running the demo. The event store table is `act.wolfdesk`.

### Read model — SQLite

The `tickets` table lives in `packages/wolfdesk/local.db` (libSQL). Drizzle Kit manages migrations:

```bash
pnpm -F wolfdesk drizzle:migrate    # generate + apply migrations (also runs as part of `dev`)
pnpm -F wolfdesk drizzle:push       # push schema directly without a migration
pnpm -F wolfdesk drizzle:studio     # open Drizzle Studio against local.db
```

## Tests

```bash
pnpm -F wolfdesk test
```

- `ticket.spec.ts` — single ticket open/assign/message/close happy path
- `tickets.spec.ts` — multi-ticket flows, projection assertions, and job-driven escalation/reassignment/close
- `invariants.spec.ts` — invariant violations and domain errors

Tests use the InMemoryStore for events and a freshly initialized SQLite file for the projection (`init_tickets_db()` in `beforeAll`).

## Related

- [`@rotorsoft/act`](../../libs/act) — core framework (slices, projections, invariants)
- [`@rotorsoft/act-pg`](../../libs/act-pg) — PostgreSQL event store adapter
- [`@act/calculator`](../calculator) — single-aggregate, simpler example
- [Learning Domain-Driven Design](https://www.oreilly.com/library/view/learning-domain-driven-design/9781098100124/) — the Wolfdesk case study Vlad Khononov uses to teach DDD strategic and tactical patterns
