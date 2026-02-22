---
name: scaffold-act-app
description: Scaffolds a new TypeScript application using the @rotorsoft/act event sourcing framework. Translates functional specs — event modeling diagrams, event storming artifacts, or user stories — into a working monorepo with domain logic, tRPC API, and React client. Use when the user wants to build a new app, create a new project, or translate a domain model into code using Act.
---

# Scaffold an Act Application

Build a TypeScript monorepo application using `@rotorsoft/act` from a functional specification.

**References:** [act-api.md](act-api.md) (type signatures & gotchas) · [monorepo-template.md](monorepo-template.md) (config files) · [production.md](production.md) (deployment)

## Spec-to-Code Mapping

| Spec Artifact | Framework Artifact | Builder / API |
|---|---|---|
| Aggregate / Entity | State | `state({ Name: schema })` |
| Command | Action | `.on({ ActionName: schema })` |
| Domain Event | Event + Patch | `.emits({ Event: schema })` + optional `.patch({...})` for custom reducers |
| Business Rule / Guard | Invariant | `.given([{ description, valid }])` |
| Policy / Process Manager | Reaction (Slice or Act) | `.on("Event").do(handler)` |
| Read Model / Query | Projection | `projection("target").on({ Event }).do(handler)` |
| Bounded Context / Feature | Slice | `slice().withState(State)` |
| System / Orchestrator | Act | `act().withActor<T>().withSlice(Slice).build()` |

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
| Domain Event, Fact, State Change | Event | `.emits({ Event: schema })` + optional `.patch({})` for custom reducers |
| Read Model, View, Query Model, Projection | Projection | `projection("target").on({ Event }).do(handler)` |
| Policy, Process Manager, Automation, Saga, Reactor | Reaction | `slice().withState(State).on("Event").do(handler)` |
| Invariant, Guard, Business Rule, Precondition, Constraint | Invariant | `.given([{ description, valid }])` |
| Specification, Acceptance Criteria, Given-When-Then, Scenario | Test case | `describe / it` block |
| Screen, UI, View, Page | Client component | tRPC procedure + React component |
| Bounded Context, Module, Feature, Slice | Slice | `slice().withState(State)` |
| External Event, Integration Event | Reaction trigger | Event from another aggregate's stream |
| User Role, Permission, Auth | Actor type + middleware | `withActor<T>()` + tRPC middleware |

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

- **Internal events** — emitted by the aggregate's own actions → define in `.emits({})` and optionally `.patch({})` for custom reducers (passthrough is the default)
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
│   │   │   ├── schemas.ts        # Zod schemas (actions, events, state) + AppActor type
│   │   │   ├── invariants.ts     # Business rules
│   │   │   ├── <feature>.ts      # State + Slice per feature (co-locate projection)
│   │   │   ├── bootstrap.ts      # act().withActor<T>().withSlice().build()
│   │   │   └── index.ts          # Barrel exports
│   │   └── test/
│   │       └── <feature>.spec.ts
│   └── app/              # Server + Client in one package
│       ├── src/
│       │   ├── api/              # tRPC router (decomposed)
│       │   │   ├── index.ts      # Router composition + AppRouter type
│       │   │   ├── trpc.ts       # tRPC init + middleware (public/authed/admin)
│       │   │   ├── context.ts    # Request context + token verification
│       │   │   ├── helpers.ts    # serializeEvents() for SSE payloads
│       │   │   ├── auth.ts       # Token signing, password hashing
│       │   │   ├── auth.routes.ts    # Auth endpoints (login, signup, OAuth)
│       │   │   ├── domain.routes.ts  # Domain mutations + queries
│       │   │   └── events.routes.ts  # SSE subscription
│       │   ├── client/           # React + Vite frontend
│       │   │   ├── App.tsx           # Root (providers, splitLink for SSE)
│       │   │   ├── main.tsx          # Entry point
│       │   │   ├── trpc.ts           # tRPC React client
│       │   │   ├── types.ts          # Shared client types
│       │   │   ├── data/             # Static catalog data
│       │   │   ├── hooks/            # Custom hooks (useAuth, useCart, useEventStream)
│       │   │   ├── components/       # UI components
│       │   │   ├── views/            # Page-level views
│       │   │   └── styles/           # CSS files
│       │   ├── server.ts         # Production server (static + API)
│       │   └── dev-server.ts     # Dev server (seed data + API)
│       ├── index.html
│       ├── vite.config.ts
│       ├── tsconfig.json         # References app + server configs
│       ├── tsconfig.app.json     # Client + API (bundler resolution)
│       └── tsconfig.server.json  # Server + API (emit JS)
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

> **Important:** Every `package.json` that imports `@rotorsoft/act` must have `name` and `version` fields (both `z.string().min(1)`). Act reads `package.json` from CWD at import time and validates these fields — missing or empty values cause a startup error.

For complete workspace configuration files, see [monorepo-template.md](monorepo-template.md).

## Build Process

### Step 1 — Define Schemas & Actor Type

All Zod schemas and the custom actor type in `packages/domain/src/schemas.ts`.

```typescript
import type { Actor } from "@rotorsoft/act";
import { ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

// === Custom Actor (extends base Actor with app-specific fields) ===
export type AppActor = Actor & {
  picture?: string;
  role: "admin" | "user" | "system";
};

export const systemActor: AppActor = { id: "system", name: "System", role: "system" };

// Actions
export const CreateItem = z.object({ name: z.string().min(1) });
export const CloseItem = ZodEmpty;

// Events (immutable — never modify published schemas)
export const ItemCreated = z.object({ name: z.string(), createdBy: z.string() });
export const ItemClosed = z.object({ closedBy: z.string() });

// State
export const ItemState = z.object({
  name: z.string(),
  status: z.string(),
  createdBy: z.string(),
});
```

Use `ZodEmpty` for empty payloads. Use `.and()` or `.extend()` for composition.

**AppActor pattern**: Extend the base `Actor` type with domain-specific fields like `role` for authorization. Define a `systemActor` constant for reactions and seed scripts.

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
  .patch({  // optional — only for events needing custom reducers (passthrough is the default)
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

**Builder chain**: `state({})` → `.init()` → `.emits({})` → optional `.patch({})` → `.on({})` → `.given([])` → `.emit(handler | "EventName")` → `.build()`

**Passthrough defaults**: `.emits()` creates default passthrough reducers (`({ data }) => data`) for all events. Use `.patch()` only to override events that need custom logic. Use `.emit("EventName")` when the action payload maps directly to event data.

**Emit handler**: `(actionPayload, snapshot, target) => [EventName, data]` — destructure as `(data, { state }, { stream, actor })`.

**Partial states**: Multiple states sharing the same name (e.g., `state({ Ticket: PartialA })` and `state({ Ticket: PartialB })`) merge automatically in slices/act.

### Step 4 — Define Slices with Co-located Projections

Group states with reactions and projections for vertical slice architecture. Each feature file exports both the State and Slice, co-locating the projection:

```typescript
import { projection, slice, state } from "@rotorsoft/act";
import { Item } from "./item.js";
import { ItemCreated, ItemClosed } from "./schemas.js";

// === Projection co-located with slice ===
const items = new Map<string, { name: string; status: string }>();

export const ItemProjection = projection("items")
  .on({ ItemCreated })
  .do(async (event) => {
    items.set(event.stream, { name: event.data.name, status: "Open" });
  })
  .on({ ItemClosed })
  .do(async (event) => {
    const item = items.get(event.stream);
    if (item) item.status = "Closed";
  })
  .build();

// === Query functions for the read model ===
export function getItems() {
  return Object.fromEntries(items.entries());
}

export function clearItems() {
  items.clear();
}

// === Slice ===
export const ItemSlice = slice()
  .withState(Item)
  .withProjection(ItemProjection)
  .on("ItemCreated")  // plain string, NOT record shorthand
  .do(async function notify(event, stream, app) {
    // app is a typed Dispatcher — use for cross-state actions
    // Pass event as 4th arg for causation tracking
    await app.do("SomeAction", { stream, actor: systemActor }, payload, event);
  })
  .to((event) => ({ target: event.stream }))  // target stream for drain processing
  .build();
```

**Co-location pattern**: Keep projection, query functions, and `clear*()` helpers together with the slice. This keeps the read model close to the events that build it.

**Query functions**: Export plain functions (`getItems()`, `getItemsByActor()`) that query the in-memory projection state. These are called from tRPC query procedures.

**clear*() helpers**: Export a `clear*()` function to reset projection state in tests.

> **Warning:** `.void()` reactions are **NEVER processed by `drain()`** — the void resolver returns `undefined`, so drain skips them entirely. Use `.to(resolver)` for any reaction that must be discovered and executed during drain. Reserve `.void()` only for inline side effects (logging, metrics) that don't need drain processing. See [act-api.md](act-api.md) §4.

### Step 5 — Cross-Aggregate Projections

Projections can consume events from multiple aggregates. Include the additional state in the slice to make the events available:

```typescript
// inventory.ts — consumes events from both Inventory and Cart aggregates
import { Cart } from "./cart.js";

export const InventorySlice = slice()
  .withState(Cart)        // needed to consume CartPublished events
  .withState(Inventory)
  .withProjection(InventoryProjection)
  .build();
```

### Step 6 — Bootstrap with Generic Actor

```typescript
import { act } from "@rotorsoft/act";
import type { AppActor } from "./schemas.js";
import { ItemSlice } from "./item.js";
import { InventorySlice } from "./inventory.js";

export const app = act()
  .withActor<AppActor>()    // generic actor type — enforces typed actors in app.do()
  .withSlice(ItemSlice)
  .withSlice(InventorySlice)
  .build();
```

**`withActor<T>()`**: Sets the actor type for the entire app. All `app.do()` calls will require `target.actor` to satisfy `T`. Define `AppActor` extending `Actor` in schemas.ts.

> **Note:** When using reactions with `drain()`, you must call `app.correlate()` before `app.drain()` to discover target streams. Use `app.settle()` for non-blocking, debounced correlate→drain that emits a `"settled"` event when the system is consistent. See [act-api.md](act-api.md) §6.

### Step 7 — tRPC API (in `packages/app/src/api/`)

Decompose the API into focused route modules. See [monorepo-template.md](monorepo-template.md) for complete file contents.

| File | Purpose | Key pattern |
|---|---|---|
| `trpc.ts` | tRPC init + middleware | `publicProcedure`, `authedProcedure`, `adminProcedure` |
| `context.ts` | Request context | Extract `AppActor` from Bearer token via `verifyToken()` |
| `auth.ts` | Token + password crypto | HMAC-signed tokens, scrypt password hashing (zero deps) |
| `helpers.ts` | Event serialization | `serializeEvents()` for SSE payloads |
| `auth.routes.ts` | Auth endpoints | login, signup, me, assignRole, listUsers |
| `domain.routes.ts` | Domain mutations + queries | `app.do()` + `scheduleDrain()` per mutation; query projections |
| `events.routes.ts` | SSE subscription | `tracked()` yields with `app.on("settled")` for live updates |
| `index.ts` | Router composition | `t.mergeRouters()` + export `AppRouter` type |

**Key rules:**
- Call `app.settle()` after every `app.do()` in mutations — non-blocking, returns immediately
- Use `authedProcedure` / `adminProcedure` for authorization (middleware narrows `ctx.actor`)
- SSE uses `app.on("settled", ...)` which fires only after `correlate()` + `drain()` complete

### Step 8 — React Client (in `packages/app/src/client/`)

See [monorepo-template.md](monorepo-template.md) for complete file contents (`App.tsx`, `trpc.ts`, `main.tsx`, hooks).

**Key patterns:**
- `App.tsx` uses `splitLink` — routes subscriptions through `httpSubscriptionLink` (SSE), mutations/queries through `httpLink`
- `useEventStream` hook subscribes to SSE, deduplicates by event ID, and calls `utils.<query>.invalidate()` on relevant events
- `useAuth` hook provides `AuthProvider` context with `signIn`, `signUp`, `signOut`, and role-based access (`isAdmin`)

### Step 9 — Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { store, type Target } from "@rotorsoft/act";
import { app, Item, clearItems, getItems, type AppActor } from "../src/index.js";

const actor: AppActor = { id: "user-1", name: "Test", role: "user" };
const target = (stream = crypto.randomUUID()): Target => ({ stream, actor });

describe("Item", () => {
  beforeEach(async () => {
    await store().seed();
    clearItems();        // reset projections between tests
  });

  it("should create", async () => {
    const t = target();
    await app.do("CreateItem", t, { name: "Test" });
    const snap = await app.load(Item, t.stream);
    expect(snap.state.name).toBe("Test");
  });

  it("should enforce invariants", async () => {
    await expect(app.do("CloseItem", target(), {})).rejects.toThrow();
  });

  it("should process reactions and projections", async () => {
    const t = target();
    await app.do("CreateItem", t, { name: "Test" });
    await app.correlate();  // discover reaction target streams first
    await app.drain({ streamLimit: 10, eventLimit: 100 });

    // Verify projection was updated
    const items = getItems();
    expect(items[t.stream]).toBeDefined();
  });
});
```

**Test isolation**: Always call `store().seed()` AND `clear*()` for each projection in `beforeEach`. This ensures both event store and read models are clean.

### Step 10 — Install Dependencies

See [monorepo-template.md](monorepo-template.md) for complete `package.json` files with exact versions.

## Strict Rules

1. **Immutable events** — Never modify a published event schema. Add new events instead.
2. **Zod schemas mandatory** — All actions, events, and states require Zod schemas. Use `ZodEmpty` for empty payloads.
3. **Actor context required** — Every `app.do()` needs `Target` with `{ stream, actor: { id, name } }`. Use `withActor<AppActor>()` to enforce typed actors.
4. **Partial patches** — Patch handlers return only changed fields, not the full state.
5. **Causation tracking** — Pass triggering event as 4th arg in reactions: `app.do(action, target, payload, event)`.
6. **Domain isolation** — `packages/domain` has zero infrastructure deps (except `@rotorsoft/act` and `zod`).
7. **InMemoryStore for tests** — Default store. Call `store().seed()` in `beforeEach`. Call `clear*()` for each projection.
8. **TypeScript strict mode** — All packages use `"strict": true`.
9. **ESM only** — All packages use `"type": "module"` and `.js` import extensions.
10. **Single-key records** — `state({})`, `.on({})`, `.emits({})` take single-key records. Multi-key throws at runtime.
11. **API decomposition** — Split tRPC router into focused route files (`auth.routes.ts`, `domain.routes.ts`, `events.routes.ts`). Keep `trpc.ts` for init + middleware, `context.ts` for request context, `helpers.ts` for shared utilities.
12. **settle() after mutations** — Call `app.settle()` after every `app.do()` in API mutations. This is non-blocking (returns immediately), debounced (coalesces rapid commits), and emits a `"settled"` event only after all correlate/drain iterations and projections are fully processed.

## Error Handling

| Error | Cause | Resolution |
|---|---|---|
| `ValidationError` | Payload fails Zod validation | Fix payload to match schema |
| `InvariantError` | Business rule failed in `.given()` | Check preconditions |
| `ConcurrencyError` | Stream version mismatch | Retry: reload state and re-dispatch |

For production deployment (PostgresStore, background processing, automated jobs), see [production.md](production.md).

## Completion Checklist

- [ ] All Zod schemas defined for actions, events, and states
- [ ] AppActor type defined extending Actor, systemActor constant exported
- [ ] Every action emits at least one event
- [ ] Patch handlers are pure functions returning partial state
- [ ] Invariants enforce all business rules
- [ ] Reactions pass triggering event for causation tracking
- [ ] Projections co-located with slices, with query and clear functions
- [ ] Tests use InMemoryStore with `store().seed()` and `clear*()` in `beforeEach`
- [ ] Domain package has no infrastructure dependencies
- [ ] All packages use `"type": "module"` and TypeScript strict mode
- [ ] tRPC API decomposed into route files with typed middleware
- [ ] SSE subscription wired with `app.on("settled")` for live events
- [ ] `app.settle()` called after mutations (non-blocking, debounced, emits "settled" after reactions)
- [ ] Client uses `splitLink` for SSE subscriptions + HTTP for mutations/queries
- [ ] Types compile with `npx tsc --noEmit`
