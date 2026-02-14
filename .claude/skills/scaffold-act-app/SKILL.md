---
name: scaffold-act-app
description: Scaffolds a new TypeScript application using the @rotorsoft/act event sourcing framework. Translates functional specs — event modeling diagrams, event storming artifacts, or user stories — into a working monorepo with domain logic, tRPC API, and React client. Use when the user wants to build a new app, create a new project, or translate a domain model into code using Act.
---

# Scaffold an Act Application

Build a TypeScript monorepo application using `@rotorsoft/act` from a functional specification.

## Spec-to-Code Mapping

| Spec Artifact | Framework Artifact | Builder / API |
|---|---|---|
| Aggregate / Entity | State | `state({ Name: schema })` |
| Command | Action | `.on({ ActionName: schema })` |
| Domain Event | Event + Patch | `.emits({ Event: schema })` + `.patch({...})` |
| Business Rule / Guard | Invariant | `.given([{ description, valid }])` |
| Policy / Process Manager | Reaction (Slice or Act) | `.on("Event").do(handler)` |
| Read Model / Query | Projection | `projection("target").on({ Event }).do(handler)` |
| Bounded Context / Feature | Slice | `slice().with(State)` |
| System / Orchestrator | Act | `act().with(State\|Slice\|Projection).build()` |

**Event Modeling**: Blue = Action, Orange = Event + Patch, Green = Projection, Lilac = Reaction, Aggregate swim lane = State.

**Event Storming**: Blue = Action, Orange = Event + Patch, Yellow = State, Lilac = Reaction, Green = Projection, Red = Invariant.

## Analyze the Specification

Before writing any code, fetch and parse the spec to extract domain artifacts. This section applies to **any** spec format — event modeling diagrams, event storming boards, domain stories, user stories, config files, or prose requirements.

### Fetch and Parse

1. Fetch the spec URL (or read the provided file/text)
2. Identify the format (JSON config, Miro export, markdown, YAML, prose, etc.)
3. Extract domain artifacts using the vocabulary mapping below

### Generic Vocabulary Mapping

Specs use varied terminology. Map to framework concepts:

| Spec Term (any tool/language) | Framework Concept | Builder API |
|---|---|---|
| Aggregate, Entity, Actor, Domain Object | State | `state({ Name: schema })` |
| Command, Action, Intent, Request | Action | `.on({ ActionName: schema })` |
| Domain Event, Fact, State Change | Event | `.emits({ Event: schema })` + `.patch({})` |
| Read Model, View, Query Model, Projection | Projection | `projection("target").on({ Event }).do(handler)` |
| Policy, Process Manager, Automation, Saga, Reactor | Reaction | `slice().on("Event").do(handler)` |
| Invariant, Guard, Business Rule, Precondition, Constraint | Invariant | `.given([{ description, valid }])` |
| Specification, Acceptance Criteria, Given-When-Then, Scenario | Test case | `describe / it` block |
| Screen, UI, View, Page | Client component | tRPC procedure + React component |
| Bounded Context, Module, Feature, Slice | Slice | `slice().with(State)` |
| External Event, Integration Event | Reaction trigger | Event from another aggregate's stream |

### Field Type Mapping

Map spec field types to Zod schemas:

| Spec Type | Zod Schema |
|---|---|
| UUID, ID | `z.uuid()` |
| String, Text | `z.string()` |
| Number, Integer, Int | `z.int()` |
| Double, Float, Decimal | `z.number()` |
| Boolean, Bool | `z.boolean()` |
| Date, DateTime, Timestamp | `z.iso.datetime()` |
| List, Array, Collection | `z.array(innerSchema)` |
| Enum | `z.enum(["A", "B"])` |
| Optional, Nullable | `.optional()` |

### Deriving State Shape

The state schema is the **accumulation of all event fields** for that aggregate:

1. Collect every event the aggregate emits
2. Union all their fields — that is the state shape
3. `init()` returns zero/empty values for each field (`""` for strings, `0` for numbers, `false` for booleans, `[]` for arrays)

### External vs Internal Events

- **Internal events** — emitted by the aggregate's own actions → define in `.emits({})` and `.patch({})`
- **External/integration events** — emitted by other aggregates → handle as **reaction triggers** in a slice (`.on("ExternalEvent").do(handler)`) or at the act level

### Given/When/Then → Tests

Translate spec scenarios directly into test cases:

- **Given** (preconditions) → seed events via `app.do()` to set up state
- **When** (action) → dispatch the action under test via `app.do()`
- **Then** (assertions) → assert emitted events, final state (`app.load()`), or expected errors (`rejects.toThrow()`)

```typescript
it("should close an open ticket", async () => {
  // Given — an open ticket
  await app.do("OpenTicket", target, { title: "Bug" });
  // When — close it
  await app.do("CloseTicket", target, { reason: "Fixed" });
  // Then — state reflects closure
  const snap = await app.load(Ticket, target.stream);
  expect(snap.state.status).toBe("Closed");
});
```

## Monorepo Architecture

```
my-app/
├── packages/
│   ├── domain/           # Pure domain logic — zero infrastructure deps
│   │   ├── src/
│   │   │   ├── schemas.ts        # Zod schemas (actions, events, state)
│   │   │   ├── invariants.ts     # Business rules
│   │   │   ├── <feature>.ts      # State + Slice per feature
│   │   │   ├── projections.ts    # Read-model updaters
│   │   │   ├── bootstrap.ts      # act().with(...).build()
│   │   │   └── index.ts          # Barrel exports
│   │   └── test/
│   │       └── <feature>.spec.ts
│   ├── server/           # tRPC API layer
│   │   └── src/server.ts
│   └── client/           # React + Vite frontend
│       └── src/
│           ├── trpc.ts, App.tsx, main.tsx
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

For complete workspace configuration files, see [monorepo-template.md](monorepo-template.md).

## Build Process

### Step 1 — Define Schemas

All Zod schemas in `packages/domain/src/schemas.ts`.

```typescript
import { ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

// Actions
export const CreateItem = z.object({ name: z.string().min(1) });
export const CloseItem = ZodEmpty;

// Events (immutable — never modify published schemas)
export const ItemCreated = z.object({ name: z.string(), createdBy: z.uuid() });
export const ItemClosed = z.object({ closedBy: z.uuid() });

// State
export const ItemState = z.object({
  name: z.string(),
  status: z.string(),
  createdBy: z.uuid(),
});
```

Use `ZodEmpty` for empty payloads. Use `.and()` or `.extend()` for composition.

### Step 2 — Define Invariants

In `packages/domain/src/invariants.ts`:

```typescript
import { type Invariant } from "@rotorsoft/act";

export const mustBeOpen: Invariant<{ status: string }> = {
  description: "Item must be open",
  valid: (state) => state.status === "Open",
};
```

`Invariant<S>` requires `{ description: string; valid: (state: Readonly<S>, actor?: Actor) => boolean }`. Type `S` with minimal fields (contravariance allows assignment to subtypes).

### Step 3 — Define States

```typescript
import { state } from "@rotorsoft/act";
import { CreateItem, CloseItem, ItemCreated, ItemClosed, ItemState } from "./schemas.js";
import { mustBeOpen } from "./invariants.js";

export const Item = state({ Item: ItemState })
  .init(() => ({ name: "", status: "Open", createdBy: "" }))
  .emits({ ItemCreated, ItemClosed })
  .patch({
    ItemCreated: ({ data }) => ({ name: data.name, createdBy: data.createdBy }),
    ItemClosed: ({ data }) => ({ closedBy: data.closedBy, status: "Closed" }),
  })
  .on({ CreateItem })
  .emit((data, { state }, { actor }) => ["ItemCreated", { ...data, createdBy: actor.id }])
  .on({ CloseItem })
  .given([mustBeOpen])
  .emit((_, __, { actor }) => ["ItemClosed", { closedBy: actor.id }])
  .build();
```

**Builder chain**: `state({})` → `.init()` → `.emits({})` → `.patch({})` → `.on({})` → `.given([])` → `.emit(handler)` → `.build()`

**Emit handler**: `(actionPayload, snapshot, target) => [EventName, data]` — destructure as `(data, { state }, { stream, actor })`.

**Partial states**: Multiple states sharing the same name (e.g., `state({ Ticket: PartialA })` and `state({ Ticket: PartialB })`) merge automatically in slices/act.

### Step 4 — Define Slices

Group states with reactions for vertical slice architecture:

```typescript
import { slice } from "@rotorsoft/act";
import { Item } from "./item.js";

export const ItemSlice = slice()
  .with(Item)
  .on("ItemCreated")  // plain string, NOT record shorthand
  .do(async function notify(event, _stream, app) {
    // app is a typed Dispatcher — use for cross-state actions
    // Pass event as 4th arg for causation tracking
    await app.do("SomeAction", target, payload, event);
  })
  .void()  // or .to("target-stream") or .to((event) => ({ target: "..." }))
  .build();
```

### Step 5 — Define Projections

Update read models from events:

```typescript
import { projection } from "@rotorsoft/act";
import { ItemCreated } from "./schemas.js";

export const ItemProjection = projection("items")
  .on({ ItemCreated })  // record shorthand (like state .on)
  .do(async function created({ stream, data }) {
    await db.insert(items).values({ id: stream, ...data });
  })
  .build();
```

Projection handlers receive `(event, stream)` — no Dispatcher.

### Step 6 — Bootstrap

```typescript
import { act } from "@rotorsoft/act";
import { ItemSlice } from "./item.js";
import { ItemProjection } from "./projections.js";

export const app = act()
  .with(ItemSlice)
  .with(ItemProjection)
  .build();
```

### Step 7 — tRPC Router

```typescript
import { app, Item } from "@my-app/domain";
import { type Target } from "@rotorsoft/act";
import { initTRPC } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";

const t = initTRPC.create();
export const appRouter = t.router({
  CreateItem: t.procedure
    .input(Item.actions.CreateItem)  // Zod schema from state
    .mutation(({ input }) => {
      const target: Target = { stream: crypto.randomUUID(), actor: { id: "user-1", name: "User" } };
      return app.do("CreateItem", target, input);
    }),
});
export type AppRouter = typeof appRouter;

createHTTPServer({ middleware: cors(), router: appRouter }).listen(4000);
```

### Step 8 — React Client

```typescript
// trpc.ts
import { type AppRouter } from "@my-app/server";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCReact, httpLink } from "@trpc/react-query";

export const trpc = createTRPCReact<AppRouter>();
export const queryClient = new QueryClient();
export const client = trpc.createClient({ links: [httpLink({ url: "http://localhost:4000" })] });
```

### Step 9 — Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { store, type Target } from "@rotorsoft/act";
import { app, Item } from "../src/index.js";

const target = (stream = crypto.randomUUID()): Target => ({
  stream, actor: { id: "user-1", name: "Test" },
});

describe("Item", () => {
  beforeEach(async () => { await store().seed(); });

  it("should create", async () => {
    const t = target();
    await app.do("CreateItem", t, { name: "Test" });
    const snap = await app.load(Item, t.stream);
    expect(snap.state.name).toBe("Test");
  });

  it("should enforce invariants", async () => {
    await expect(app.do("CloseItem", target(), {})).rejects.toThrow();
  });

  it("should process reactions", async () => {
    const t = target();
    await app.do("CreateItem", t, { name: "Test" });
    await app.drain({ streamLimit: 10, eventLimit: 100 });
  });
});
```

### Step 10 — Install Dependencies

See [monorepo-template.md](monorepo-template.md) for complete `package.json` files with exact versions.

## Strict Rules

1. **Immutable events** — Never modify a published event schema. Add new events instead.
2. **Zod schemas mandatory** — All actions, events, and states require Zod schemas. Use `ZodEmpty` for empty payloads.
3. **Actor context required** — Every `app.do()` needs `Target` with `{ stream, actor: { id, name } }`.
4. **Partial patches** — Patch handlers return only changed fields, not the full state.
5. **Causation tracking** — Pass triggering event as 4th arg in reactions: `app.do(action, target, payload, event)`.
6. **Domain isolation** — `packages/domain` has zero infrastructure deps (except `@rotorsoft/act` and `zod`).
7. **InMemoryStore for tests** — Default store. Call `store().seed()` in `beforeEach`.
8. **TypeScript strict mode** — All packages use `"strict": true`.
9. **ESM only** — All packages use `"type": "module"` and `.js` import extensions.
10. **Single-key records** — `state({})`, `.on({})`, `.emits({})` take single-key records. Multi-key throws at runtime.

## Error Handling

| Error | Cause | Resolution |
|---|---|---|
| `ValidationError` | Payload fails Zod validation | Fix payload to match schema |
| `InvariantError` | Business rule failed in `.given()` | Check preconditions |
| `ConcurrencyError` | Stream version mismatch | Retry: reload state and re-dispatch |

For production deployment (PostgresStore, background processing, automated jobs), see [production.md](production.md).

## Completion Checklist

- [ ] All Zod schemas defined for actions, events, and states
- [ ] Every action emits at least one event
- [ ] Patch handlers are pure functions returning partial state
- [ ] Invariants enforce all business rules
- [ ] Reactions pass triggering event for causation tracking
- [ ] Tests use InMemoryStore with `store().seed()` in `beforeEach`
- [ ] Domain package has no infrastructure dependencies
- [ ] All packages use `"type": "module"` and TypeScript strict mode
- [ ] tRPC router uses `State.actions.ActionName` as input validators
- [ ] Types compile with `npx tsc --noEmit`
