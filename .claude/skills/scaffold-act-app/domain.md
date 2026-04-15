# Domain Package

Pure domain logic in `packages/domain/` — zero infrastructure deps (only `@rotorsoft/act` and `zod`).

**Why a separate domain package?** Domain logic must be testable without databases, HTTP servers, or React. Keeping it isolated forces clean boundaries — if you find yourself importing `cors` or `@trpc/server` here, the dependency is going the wrong direction. The domain package is the only one that matters for correctness; everything else is infrastructure glue.

**Build order matters.** States must exist before slices (slices merge state partials). Schemas must exist before states (states reference them). Invariants can be defined alongside or before states. Bootstrap comes last — it wires everything together. If you define slices before their states, the build will fail with missing event errors.

## Schemas & Actor Type

All Zod schemas and the custom actor type in `packages/domain/src/schemas.ts`.

**Deciding what goes in schemas.ts vs feature files:** Put *shared* schemas here — the AppActor type, systemActor constant, and any schemas referenced across multiple features. Feature-specific schemas (used by only one state) can live in the feature file instead. The key rule: if two features import the same schema, it belongs in schemas.ts.

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
// NOTE: Do NOT add timestamp fields (createdAt, updatedAt, etc.) to events.
// Every committed event has a `created` timestamp from the framework.
// Only include business dates distinct from event creation (e.g., transaction_date).
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

## Invariants

**When to create an invariant vs inline validation:** Invariants enforce business rules that depend on *current state* — "ticket must be open to close it." If the rule only validates *input shape* (e.g., "name must be non-empty"), that belongs in the Zod schema, not an invariant. Invariants run *after* Zod validation, *before* the emit handler. If an invariant fails, no event is emitted.

**Actor-aware invariants:** The `valid` function receives an optional second parameter `actor`. Use this for authorization rules like "only the assigned user can close this ticket." Keep authorization invariants separate from state invariants for clarity.

In `packages/domain/src/invariants.ts`:

```typescript
import { type Invariant } from "@rotorsoft/act";

export const mustBeOpen: Invariant<{ status: string }> = {
  description: "Item must be open",
  valid: (state) => state.status === "Open",
};
```

`Invariant<S>` requires `{ description: string; valid: (state: Readonly<S>, actor?: Actor) => boolean }`. Type `S` with minimal fields (contravariance allows assignment to subtypes).

## States

**Deciding when to use `.patch()` vs passthrough:** Most events don't need custom reducers — if the event data shape matches the state fields you want to update, passthrough works (the event data merges into state). Use `.patch()` only when: (1) the event data needs transformation before it becomes state (e.g., computing a derived field), (2) you need to read current state to compute the new value (e.g., incrementing a counter), or (3) the event updates fields not present in the event data (e.g., setting `status: "Closed"` from a `ClosedBy` event). A common AI mistake is adding `.patch()` entries that just return `({ data }) => data` — this is redundant since passthrough is the default.

**Deciding between `.emit("EventName")` string passthrough and a handler function:** Use the string form when the action payload matches the event data exactly — no transformation needed. Use the handler function when you need to: add fields from the actor (`createdBy: actor.id`), compute values from state, or emit multiple/conditional events. The string form is cleaner and less error-prone.

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

**Partial states**: Multiple states sharing the same name (e.g., `state({ Ticket: PartialA })` and `state({ Ticket: PartialB })`) merge automatically in slices/act. When a partial redeclares an event in `.emits()` without a `.patch()`, it gets a passthrough reducer that yields to any custom reducer from another partial. Two different custom patches for the same event throw at build time.

## Slices with Co-located Projections

**When to use a slice vs a standalone reaction at the act level:** Use slices when the reaction is part of a feature's vertical slice — it naturally groups with the state it modifies. Use act-level reactions (`.on("Event").do(handler)`) only for cross-cutting concerns that don't belong to any single feature (e.g., global audit logging). In practice, almost all reactions belong in slices.

**Slice design decisions:**

- **Lifecycle slice first** — every state starts with a lifecycle slice that owns the CRUD-like actions (create, update, close/delete). It may also contain simple reaction flows.
- **One slice per reaction flow** — when reaction chains grow, each serial chain (event → reaction → action → state → event → reaction → …) lives in its own slice. A long serial chain stays in one slice when there is no fan-out at any junction point.
- **Slices are minimal and self-contained** — each slice includes only the state it owns. It defines its own actions, events, patches, reactions, and projections.
- **Single state schema, multiple partials** — one Zod schema defines the full state shape. Each slice declares a partial via `state({ Name: Schema })` with its own `.init()`, `.emits()`, `.patch()`, and `.on()`. The framework merges partials at build time.
- **Redeclare trigger events via `.emits()`** — when a slice reacts to an event it doesn't produce, it redeclares the event in `.emits()` so `.on("EventName")` compiles. The passthrough default is discarded in favor of the custom reducer from the owning partial.
- **One custom patch per event enforced at build time** — conflicting custom patches throw. Passthroughs always yield to custom reducers.
- **Serial chains connect slices** — when one slice's output event is another's input with no other subscribers, they can be merged into a single slice.

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
    // app implements IAct — dispatch actions, load state, query events
    // Pass event as 4th arg for causation tracking
    await app.do("SomeAction", { stream, actor: systemActor }, payload, event);
  })
  .to((event) => ({ target: event.stream }))  // target stream for drain processing
  .build();
```

**Co-location pattern**: Keep projection, query functions, and `clear*()` helpers together with the slice. This keeps the read model close to the events that build it.

**Query functions**: Export plain functions (`getItems()`, `getItemsByActor()`) that query the in-memory projection state. These are called from tRPC query procedures.

**clear*() helpers**: Export a `clear*()` function to reset projection state in tests.

**Lifecycle-only projections**: When using `act-sse` for real-time broadcast, projections only need to persist data for **lifecycle events** (entity created, member added, completed, deleted, etc.) — not every high-frequency operational event. The broadcast cache is the source of truth for full state; the DB stores lightweight summaries for cold-start recovery and list views. See [server.md](server.md) § Projection Optimization Strategies.

## Drizzle Projections (PostgreSQL)

For persistent read models, use Drizzle ORM projections instead of in-memory maps. Schema goes in `packages/domain/src/drizzle/schema.ts`, queries alongside the projection.

**Drizzle migration workflow:** Schema changes → `pnpm drizzle:generate` → review SQL → `pnpm drizzle:migrate`. Migrations run via `drizzle-kit` CLI (never programmatically). See [server.md](server.md) § Drizzle Migrations and [monorepo-template.md](monorepo-template.md) for config files.

```typescript
import { projection } from "@rotorsoft/act";
import { eq } from "drizzle-orm";
import { db, items } from "./drizzle/index.js";

export const ItemProjection = projection("items")
  .on({ ItemCreated })
  .do(async ({ stream, data, created }) => {
    await db().insert(items).values({
      id: stream, name: data.name, status: "open", createdBy: data.createdBy,
      createdAt: created.toISOString(),
    }).onConflictDoUpdate({
      target: items.id,
      set: { name: data.name, status: "open" },
    });
  })
  .on({ ItemClosed })
  .do(async ({ stream, data, created }) => {
    await db().update(items).set({ status: "closed", updatedAt: created.toISOString() })
      .where(eq(items.id, stream));
  })
  .build();

// Query functions use Drizzle, not in-memory state
export async function getItems() {
  return db().select().from(items);
}
```

**Key differences from in-memory projections:**
- Query functions are `async` (DB access)
- Use `onConflictDoUpdate` for idempotent projection replay
- No `clear*()` helpers needed — tests use `truncateAll()` or `drizzle-kit migrate` on a test DB
- Schema changes require a Drizzle migration (not just a code change)

**Batched Drizzle projections:** For high-throughput replay (rebuilding projections, catch-up), add `.batch()` to wrap all events in a single DB transaction. Only available on static-target projections:

```typescript
export const ItemProjection = projection("items")
  .on({ ItemCreated })
  .do(async ({ stream, data, created }) => {
    await db().insert(items).values({ id: stream, name: data.name, status: "open" })
      .onConflictDoUpdate({ target: items.id, set: { name: data.name } });
  })
  .on({ ItemClosed })
  .do(async ({ stream, data, created }) => {
    await db().update(items).set({ status: "closed" }).where(eq(items.id, stream));
  })
  .batch(async (events, stream) => {
    // All events in one transaction — one DB round-trip
    await db().transaction(async (tx) => {
      for (const event of events) {
        switch (event.name) {
          case "ItemCreated":
            await tx.insert(items).values({ id: event.stream, name: event.data.name, status: "open" })
              .onConflictDoUpdate({ target: items.id, set: { name: event.data.name } });
            break;
          case "ItemClosed":
            await tx.update(items).set({ status: "closed" }).where(eq(items.id, event.stream));
            break;
        }
      }
    });
  })
  .build();
```

`BatchEvent<TEvents>` is a discriminated union — `switch (event.name)` narrows both `name` and `data`. Add `default: never` for exhaustive checking.

## Cross-Aggregate Projections

**When a projection needs events from another aggregate:** This is the signal that your slice needs `.withState(OtherState)`. Without it, the slice won't know about the other aggregate's events and the projection handlers won't compile. This does NOT mean the slice owns that state — it just makes the events visible. The other aggregate's lifecycle slice still owns its state definition.

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

## Bootstrap

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

> **Note:** When using reactions with `drain()`, you must call `app.correlate()` before `app.drain()` to discover target streams. Use `app.settle()` for non-blocking, debounced correlate→drain that emits a `"settled"` event when the system is consistent. See [act-api.md](act-api.md) §7 (Correlate Before Drain).

## Tests

**What to test and what not to:** Test domain behavior — actions produce correct events, invariants reject invalid state transitions, reactions trigger expected downstream actions, projections build correct read models. Do NOT test framework internals (event storage, cache behavior, version numbering). Trust the framework for infrastructure; verify your business logic.

**Testing reactions requires two steps:** First `correlate()` to discover target streams, then `drain()` to process them. A common AI mistake is calling only `drain()` — it returns empty because no streams were registered. In tests, always call both explicitly. In production, `settle()` handles this automatically.

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { store, dispose, type Target } from "@rotorsoft/act";
import { app, Item, clearItems, getItems, type AppActor } from "../src/index.js";

const actor: AppActor = { id: "user-1", name: "Test", role: "user" };
const target = (stream = crypto.randomUUID()): Target => ({ stream, actor });

describe("Item", () => {
  beforeEach(async () => {
    await store().seed();
    clearItems();           // reset projections between tests
  });

  afterAll(async () => {
    await dispose()();      // disposes all adapters (store, cache, etc.)
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

**Test isolation**: Always call `store().seed()` and `clear*()` for each projection in `beforeEach`. Use `dispose()()` in `afterAll` to clean up all adapters (store, cache, etc.).
