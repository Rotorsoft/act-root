# @act/wolfdesk

A larger Act example — a help-desk ticketing system adapted from *Learning Domain-Driven Design* (Vlad Khononov). Wolfdesk shows how to compose a single aggregate from multiple **partial states** and **slices** (vertical slice architecture), with a Drizzle/SQLite read model, deferred-reaction timers for the ticket lifecycle, and a PostgreSQL event store.

> Workspace package, not published. Run via `pnpm dev:wolfdesk` from the monorepo root.

## What it demonstrates

- **One aggregate, three slices** — `Ticket` is built from three partial states (creation, messaging, operations), each owning its own actions, events, patches, and reactions
- **Slice merging** — different slices register patches for shared events; conflicts are detected at build time
- **Per-slice reactions**:
  - `TicketCreationSlice` — on `TicketOpened`, auto-assigns an agent
  - `TicketMessagingSlice` — on `MessageAdded`, calls `deliverMessage()` then dispatches `MarkMessageDelivered`
  - `TicketOpsSlice` — on `TicketEscalationRequested`, dispatches `EscalateTicket`
- **Standalone projection** — `TicketProjection` writes a denormalized read model into a Drizzle/SQLite `tickets` table
- **Deferred-reaction timers** — escalate, reassign, and close-on-inactivity run as `.defer`-based reactions that sleep until each ticket's deadline and act when they wake, with no polling loop and no read-model scan
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
2. Starts the correlation pump — the escalate / reassign / close timers are deferred reactions already wired into the app, so there's no polling loop to start; they arm themselves as tickets emit their triggering events
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
│   ├── bootstrap.ts             # Composes act() with the slices + the projection
│   ├── ticket-timers.ts         # TicketTimersSlice — deferred escalate / reassign / close timers
│   ├── errors.ts                # Domain errors
│   ├── main.ts                  # Demo entrypoint
│   ├── schemas/                 # Zod schemas (events, actions, partial state shapes)
│   ├── services/                # External integrations (agent assignment, notifications)
│   └── drizzle/                 # SQLite schema + migrations + db client
├── drizzle.config.ts            # drizzle-kit config (sqlite, file:local.db)
└── test/
    ├── actions.ts               # Helpers for action dispatch in tests
    ├── ticket.spec.ts           # Single-ticket happy paths
    ├── tickets.spec.ts          # Multi-ticket scenarios + projection asserts + deferred timers
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
  .withSlice(TicketTimersSlice)     // Deferred escalate / reassign / close timers (no events of its own)
  .withProjection(TicketProjection) // Standalone — listens across the slices
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
  .on({ TicketOpened }).do(async function insertTicket({ stream, data }) { /* insert */ })
  .on({ MessageAdded }).do(async function countMessage({ stream }) { /* messages += 1 */ })
  .on({ TicketAssigned }).do(async function assignTicket({ stream, data }) { /* update */ })
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

## Timing automations — deferred reactions

`src/ticket-timers.ts` drives the ticket lifecycle from time instead of from a polling loop. `TicketTimersSlice` replaces the old `setInterval` jobs with **deferred reactions**: instead of scanning the read model every few seconds, each timer `.defer`s to the exact deadline that already rides on the ticket's events, sleeps until then, and re-checks live state when it wakes (the same load-and-guard the jobs did against the projection, minus the query).

Each automation runs on its own per-ticket target, so a pending wait never holds up the ticket's hot-path reactions (assignment, messaging, webhooks). The handler still reads the *source* ticket from `event.stream`, not the synthetic target it leases.

**Escalate** is a one-shot. It reacts to `TicketAssigned`, defers to that event's `escalateAfter`, and on waking escalates the ticket if it's still open and not already escalated:

```ts no-check
.on("TicketAssigned")
.defer((event) => ({ at: event.data.escalateAfter }))
.do(autoEscalate)
.to((event) => ({ target: `escalate:${event.stream}`, source: event.stream }))
```

**Reassign** is a recurring chain. `TicketEscalated` and `TicketReassigned` both land on the `reassign:<id>` target. Because the escalation event carries no deadline, the handler reads `reassignAfter` from live state and re-arms with an imperative `throw new DeferSignal({ at: state.reassignAfter })`. Each `ReassignTicket` pushes the deadline forward, so the follow-on `TicketReassigned` schedules the next wait. The loop stops once the user has been answered or the ticket closes.

**Close on inactivity** reacts to `TicketOpened`. When the open event carries an optional `closeAfter`, the handler defers to it and closes the ticket on waking if it's still open; without a deadline it does nothing.

The read model's `escalate_after` / `reassign_after` / `close_after` columns are no longer the source of truth for scheduling — the deadlines live on the events — but they stay in the `tickets` table for display and debugging.

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
- `tickets.spec.ts` — multi-ticket flows, projection assertions, and defer-driven escalation/reassignment/close (set a due-now deadline, then `correlate` + `drain` to settle the deferred reactions)
- `invariants.spec.ts` — invariant violations and domain errors

Tests use the InMemoryStore for events and a freshly initialized SQLite file for the projection (`init_tickets_db()` in `beforeAll`).

## Related

- [`@rotorsoft/act`](../../libs/act) — core framework (slices, projections, invariants)
- [`@rotorsoft/act-pg`](../../libs/act-pg) — PostgreSQL event store adapter
- [`@act/calculator`](../calculator) — single-aggregate, simpler example
- [Learning Domain-Driven Design](https://www.oreilly.com/library/view/learning-domain-driven-design/9781098100124/) — the Wolfdesk case study Vlad Khononov uses to teach DDD strategic and tactical patterns
