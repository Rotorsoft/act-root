---
id: wolfdesk
title: WolfDesk
---

# WolfDesk Example

A complex ticketing system demonstrating advanced Act patterns: partial states, vertical slices, cross-aggregate reactions, projections, invariants with actor context, and deferred-reaction timers.

Inspired by the ticketing system from "Learning Domain-Driven Design" by Vlad Khononov.

**Source:** [packages/wolfdesk/src/](https://github.com/rotorsoft/act-root/tree/master/packages/wolfdesk/src)

## Architecture

```
bootstrap.ts          → act().withSlice(Creation).withSlice(Messaging).withSlice(Ops).withSlice(Timers).withProjection(Projection).build()
ticket-creation.ts    → TicketCreation state + TicketCreationSlice
ticket-messaging.ts   → TicketMessaging state + TicketMessagingSlice
ticket-operations.ts  → TicketOperations state + TicketOpsSlice
ticket-timers.ts      → TicketTimersSlice (deferred escalate / reassign / close timers)
ticket-projections.ts → TicketProjection (read model)
ticket-invariants.ts  → Business rules
schemas/              → Zod schemas for actions, events, state
services/             → External service stubs (agent assignment, notifications)
```

## Patterns Demonstrated

### Partial States

Three separate state definitions share the name `"Ticket"` and merge automatically:

```typescript no-check
// ticket-creation.ts
const TicketCreation = state({ Ticket: TicketCreationState })
  .emits({ TicketOpened, TicketClosed, TicketResolved })
  // ...

// ticket-messaging.ts
const TicketMessaging = state({ Ticket: TicketMessagingState })
  .emits({ MessageAdded, AttachmentAdded })
  // ...

// ticket-operations.ts
const TicketOperations = state({ Ticket: TicketOperationsState })
  .emits({ TicketAssigned, TicketEscalated })
  // ...
```

When composed via `act().withSlice(...)`, these merge into a single `"Ticket"` state with all actions, events, and patches combined.

### Vertical Slices

Each feature is a self-contained slice with its state and reactions:

```typescript no-check
export const TicketCreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)    // included so the reaction can dispatch AssignTicket
  .on("TicketOpened")
    .do(async function assign(event, _stream, app) {
      const agent = assignAgent(
        event.stream,
        event.data.supportCategoryId,
        event.data.priority,
      );
      await app.do(
        "AssignTicket",
        {
          stream: event.stream,
          actor: { id: randomUUID(), name: "assign reaction" },
        },
        agent,
      );
    })
  .build();
```

The slice declares `TicketOperations` via `.withState()` because its reaction dispatches `AssignTicket` — an action that lives on that partial state. Without that registration, the slice's `app.do("AssignTicket", ...)` call wouldn't typecheck.

### Cross-Aggregate Reactions

When a ticket is opened, the creation slice automatically assigns an agent by dispatching an action on the operations state. Notice the dispatch needs an explicit synthetic actor — reactions are system-driven, not user-driven, so the example mints `{ id: randomUUID(), name: "assign reaction" }` for traceability:

```typescript no-check
.on("TicketOpened").do(async function assign(event, _stream, app) {
  await app.do(
    "AssignTicket",
    { stream: event.stream, actor: { id: randomUUID(), name: "assign reaction" } },
    agent,
  );
  // reactingTo is auto-injected — the framework threads `event` into the new
  // commit's correlation/causation chain. Pass an explicit 4th argument only
  // when you want to override that default.
})
```

### Invariants with Actor Context

Business rules that check both state and the acting user:

```typescript no-check
// ticket-invariants.ts
export const mustBeOpen: Invariant<{ status: string }> = {
  description: "Ticket must be open",
  valid: (state) => state.status === "open",
};

export const mustBeUserOrAgent: Invariant<
  { userId: string; agentId?: string },
  Actor
> = {
  description: "Must be ticket owner or assigned agent",
  valid: (state, actor) =>
    state.userId === actor?.id || state.agentId === actor?.id,
};

// Used in state builder
.on({ MarkTicketResolved })
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((_, __, { actor }) => ["TicketResolved", { resolvedById: actor.id }])
```

### Projections (Read Models)

A standalone projection maintains a read model across all ticket events:

```typescript no-check
export const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async function opened({ stream, data }) {
      await db.insert(tickets).values({ id: stream, ...data });
    })
  .on({ TicketAssigned })
    .do(async function assigned({ stream, data }) {
      await db.update(tickets).set(data).where(eq(tickets.id, stream));
    })
  .on({ MessageAdded })
    .do(async function messageAdded({ stream }) {
      await db.update(tickets)
        .set({ messages: sql`${tickets.messages} + 1` })
        .where(eq(tickets.id, stream));
    })
  .build();
```

### Deferred-Reaction Timers

The ticket lifecycle needs a few things to happen on a clock: escalate an unanswered ticket after its SLA window, reassign an escalated ticket the user still hasn't answered, and close a ticket that's gone quiet. Wolfdesk drives all three from `ticket-timers.ts` as deferred reactions rather than a background polling loop. Each deadline already rides on the ticket's events, so `TicketTimersSlice` `.defer`s to that instant, sleeps, and re-checks live state when it wakes. That wake-time check is the same load-and-guard a polling job would run against the read model, without the periodic scan.

Each automation leases its own per-ticket target (`escalate:<id>`, `reassign:<id>`, `close:<id>`), so a pending wait never blocks the ticket's hot-path reactions like assignment, messaging, and webhooks. The handler reads the source ticket from `event.stream`, not the synthetic target it holds.

Escalation is a one-shot that reacts to `TicketAssigned` and defers to the event's `escalateAfter`:

```typescript no-check
.on("TicketAssigned")
.defer((event) => ({ at: event.data.escalateAfter }))
.do(autoEscalate)
.to((event) => ({ target: `escalate:${event.stream}`, source: event.stream }))
```

Reassignment is a recurring chain. Both `TicketEscalated` and `TicketReassigned` land on the `reassign:<id>` target; because the escalation event carries no deadline, the handler reads `reassignAfter` from live state and re-arms imperatively with `throw new DeferSignal({ at: state.reassignAfter })`. Each `ReassignTicket` moves the deadline forward, so the resulting `TicketReassigned` schedules the next wait, and the loop stops once the user is answered or the ticket closes. Close-on-inactivity reacts to `TicketOpened` and defers to the open event's optional `closeAfter`, closing the ticket on waking if it's still open.

### Composition

Everything is wired together in `bootstrap.ts`:

```typescript no-check
export const app = act()
  .withSlice(TicketCreationSlice)
  .withSlice(TicketMessagingSlice)
  .withSlice(TicketOpsSlice)
  .withSlice(TicketTimersSlice)
  .withProjection(TicketProjection)
  .build();
```

### Custom Error Types

Domain-specific errors for business logic:

```typescript
export class TicketCannotOpenTwiceError extends Error {
  constructor(stream: string) {
    super(`Ticket ${stream} is already open`);
  }
}
```

## Running

```bash
pnpm dev:wolfdesk
pnpm -F wolfdesk test
```
