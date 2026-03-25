# Domain Package

Pure domain logic in `packages/domain/` — zero infrastructure deps (only `@rotorsoft/act` and `zod`).

## Schemas & Actor Type

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

## Invariants

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

> **Warning:** `.void()` reactions are **NEVER processed by `drain()`** — the void resolver returns `undefined`, so drain skips them entirely. Use `.to(resolver)` for any reaction that must be discovered and executed during drain. Reserve `.void()` only for inline side effects (logging, metrics) that don't need drain processing. See [act-api.md](act-api.md) §6 (Void Reactions).

**Lifecycle-only projections**: When using `act-sse` for real-time broadcast, projections only need to persist data for **lifecycle events** (entity created, member added, completed, deleted, etc.) — not every high-frequency operational event. The broadcast cache is the source of truth for full state; the DB stores lightweight summaries for cold-start recovery and list views. See [server.md](server.md) § Projection Optimization Strategies.

## Cross-Aggregate Projections

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
