---
id: wolfdesk
title: WolfDesk
---

# WolfDesk Example

A complex ticketing system demonstrating advanced Act patterns: partial states, vertical slices, cross-aggregate reactions, projections, invariants with actor context, and background jobs.

Inspired by the ticketing system from "Learning Domain-Driven Design" by Vlad Khononov.

**Source:** [packages/wolfdesk/src/](https://github.com/rotorsoft/act-root/tree/master/packages/wolfdesk/src)

## Architecture

```
bootstrap.ts          → act().withSlice(Creation).withSlice(Messaging).withSlice(Ops).withProjection(Projection).build()
ticket-creation.ts    → TicketCreation state + TicketCreationSlice
ticket-messaging.ts   → TicketMessaging state + TicketMessagingSlice
ticket-operations.ts  → TicketOperations state + TicketOpsSlice
ticket-projections.ts → TicketProjection (read model)
ticket-invariants.ts  → Business rules
schemas/              → Zod schemas for actions, events, state
services/             → External service stubs (agent assignment, notifications)
jobs.ts               → Background processing
```

## Patterns Demonstrated

### Partial States

Three separate state definitions share the name `"Ticket"` and merge automatically:

```typescript
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

```typescript
export const TicketCreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)    // needed for cross-state dispatch
  .on("TicketOpened")
    .do(async function assign(event, _stream, app) {
      const agent = assignAgent(event.stream, event.data.supportCategoryId, event.data.priority);
      await app.do("AssignTicket", { stream: event.stream, actor }, agent, event);
    })
  .build();
```

The slice includes `TicketOperations` because its reaction needs to dispatch `AssignTicket` (an action on that state).

### Cross-Aggregate Reactions

When a ticket is opened, the creation slice automatically assigns an agent by dispatching an action on the operations state:

```typescript
.on("TicketOpened").do(async function assign(event, _stream, app) {
  await app.do("AssignTicket", { stream: event.stream, actor }, agent, event);
  //                                                                  ^^^^^ causation tracking
})
```

The triggering event is passed as the 4th argument for correlation/causation tracking.

### Invariants with Actor Context

Business rules that check both state and the acting user:

```typescript
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

```typescript
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

### Composition

Everything is wired together in `bootstrap.ts`:

```typescript
export const app = act()
  .withSlice(TicketCreationSlice)
  .withSlice(TicketMessagingSlice)
  .withSlice(TicketOpsSlice)
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
