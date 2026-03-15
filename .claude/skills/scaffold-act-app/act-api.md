# Act Framework API Quick Reference

Precise type signatures, gotchas, and patterns learned from real-world usage. Consult this before generating any Act code.

## 1. Config Validation — package.json Requirements

Act reads `package.json` from CWD at import time. The `name` and `version` fields are **required** (`z.string().min(1)`). Missing or empty values cause a validation error on startup.

```json
{
  "name": "@my-app/domain",
  "version": "0.0.1"
}
```

Every package that imports `@rotorsoft/act` must have a valid `package.json` with these fields.

## 2. Generic Actor Type — withActor\<T\>()

Use `withActor<T>()` to enforce a typed actor across the entire app. Extend the base `Actor` type with domain-specific fields:

```typescript
// packages/domain/src/schemas.ts
import type { Actor } from "@rotorsoft/act";

export type AppActor = Actor & {
  picture?: string;
  role: "admin" | "user" | "system";
};

export const systemActor: AppActor = { id: "system", name: "System", role: "system" };
```

```typescript
// packages/domain/src/bootstrap.ts
import { act } from "@rotorsoft/act";
import type { AppActor } from "./schemas.js";

export const app = act()
  .withActor<AppActor>()   // all app.do() calls require AppActor-shaped actors
  .withSlice(ItemSlice)
  .build();
```

**Key points:**
- `withActor<T>()` takes no runtime argument — it's a pure type-level constraint
- All `target.actor` objects passed to `app.do()` must satisfy `T`
- Use `systemActor` in reactions, seed scripts, and internal automation
- The actor is available in emit handlers via `target.actor` and in invariants via the optional second parameter

## 3. Patch Handler Signature

`.emits()` creates default passthrough reducers (`({ data }) => data`) for all events. Use `.patch()` only to override events that need custom reducer logic.

The framework exports `PatchHandlers<TState, TEvents>` — use it to type the `.patch()` map explicitly when needed:

```typescript
import type { PatchHandlers } from "@rotorsoft/act";

// Each handler: (event: Committed<TEvents, K>, state: Readonly<TState>) => Readonly<Patch<TState>>
// event.data is the event payload; return only the fields that change
```

**Key points:**
- `.patch()` is **optional** — events default to passthrough (event data merges into state)
- Access event payload via `event.data`, not the event directly
- The second argument is the current state, not the snapshot
- Return only the fields that change — do NOT spread the full state

```typescript
// Only override events that need custom logic
.emits({ ItemCreated, ItemClosed, ItemResolved })
.patch({
  ItemCreated: ({ data }, state) => ({ name: data.name, status: "Open" }),
  //            ^^^^^^^^  ^^^^^
  //            event      current state (2nd arg)
})
// ItemClosed and ItemResolved use passthrough — no entry needed
```

## 4. InferEvents / InferActions — Utility Types

**Never recreate mapped types manually.** Use these framework-provided utilities to extract inferred types from built State objects:

```typescript
import type { InferEvents, InferActions } from "@rotorsoft/act";

// Extract inferred event types from a State
type Events = InferEvents<typeof Item>;
// => { ItemCreated: { name: string; createdBy: string }; ItemClosed: { closedBy: string } }

// Extract inferred action types from a State
type Actions = InferActions<typeof Item>;
// => { CreateItem: { name: string }; CloseItem: Record<string, never> }

// Combine multiple states (useful for typed Dispatcher construction)
type AllEvents = InferEvents<typeof StateA> & InferEvents<typeof StateB>;
type AllActions = InferActions<typeof StateA> & InferActions<typeof StateB>;
```

**Do NOT write this manually:**
```typescript
// ❌ Don't do this
type Events = { [K in keyof typeof EventSchemas]: z.infer<(typeof EventSchemas)[K]> };

// ✅ Do this instead
type Events = InferEvents<typeof MyState>;
```

## 5. ZodEmpty — Empty Payload Schema

```typescript
// Definition in @rotorsoft/act
export const ZodEmpty = z.record(z.string(), z.never());
```

Use for actions or events with no payload data:

```typescript
import { ZodEmpty } from "@rotorsoft/act";

export const CloseItem = ZodEmpty;  // action with no payload
export const ItemClosed = ZodEmpty; // event with no data
```

Do NOT use `z.object({})` — use `ZodEmpty` for consistency and correct validation.

## 6. Void Reactions — NEVER Processed by drain()

**Critical:** `.void()` sets a reaction's resolver to return `undefined`. During `drain()`, reactions with `undefined` targets are **filtered out and skipped entirely**.

```typescript
// This reaction will NEVER be processed by drain()
.on("ItemCreated")
  .do(async (event, stream, app) => { /* ... */ })
  .void()  // ← resolver returns undefined → drain() skips this

// Use .to() for reactions that must be processed by drain()
.on("ItemCreated")
  .do(async (event, stream, app) => { /* ... */ })
  .to((event) => ({ target: event.stream }))  // ← drain() processes this
```

**When to use each:**
- `.void()` — Side-effect-only reactions triggered inline (e.g., logging, metrics). These run during commit, not during drain.
- `.to(resolver)` — Reactions that must be discovered and processed by `drain()`. The resolver returns `{ target: string, source?: string }`.

**Common resolver patterns:**
```typescript
.to((event) => ({ target: event.stream }))           // self-targeting
.to((event) => ({ target: event.data.targetId }))    // cross-stream
.to("fixed-stream-name")                             // static target
```

## 7. Correlate Before Drain — settle() Pattern

`app.correlate()` scans events, resolves reaction targets, and **registers new streams** with the store via `store().lease()`. Without this step, `drain()` won't find streams to process.

```typescript
// ✅ Correct — correlate discovers streams, then drain processes them
await app.correlate();
await app.drain();

// ❌ Wrong — drain has no streams to process
await app.drain();  // returns empty results
```

**`app.settle()`** — the production pattern for API mutations. Non-blocking, debounced, runs correlate→drain in a loop, emits `"settled"` when the system reaches a consistent state:

```typescript
// In API mutations — fire-and-forget
await app.do("CreateItem", target, input);
app.settle();  // non-blocking, debounced — UI notified via "settled" event

// Subscribe to settled event for SSE notifications
app.on("settled", (drain) => {
  // drain has { fetched, leased, acked, blocked }
  // notify SSE clients that the system is consistent
});
```

**`settle()` options:**
```typescript
app.settle({
  debounceMs: 10,                      // debounce window (default: 10ms)
  correlate: { after: -1, limit: 100 }, // correlate query (default)
  maxPasses: 5,                         // max correlate→drain loops (default: 5)
  streamLimit: 10,                      // passed to drain()
  eventLimit: 100,                      // passed to drain()
});
```

**Key design:**
- **Non-blocking**: `settle()` returns immediately — mutations don't wait for drain
- **Debounced**: Multiple rapid `app.do()` calls coalesce into one settle cycle (10ms window)
- **Guarded**: Internal `_settling` flag prevents concurrent settle cycles
- **Lifecycle event**: `"settled"` fires only after all correlate/drain iterations finish, so SSE clients see a consistent view

**In tests:** Call `correlate()` + `drain()` directly (synchronous, no debounce):
```typescript
it("should process reactions", async () => {
  await app.do("CreateItem", target, { name: "Test" });
  await app.correlate();  // ← discovers reaction target streams
  await app.drain();      // ← now processes them
});
```

**In API mutations:** Call `settle()` and return immediately:
```typescript
CreateItem: authedProcedure.mutation(async ({ input, ctx }) => {
  await app.do("CreateItem", target, input);
  app.settle();  // fire-and-forget — UI notified via "settled" event
  return { success: true };
});
```

**For background processing:** Use `app.start_correlations()` for periodic discovery:
```typescript
const stop = app.start_correlations({ after: 0, limit: 100 }, 5000);
```

## 8. Invariant Type

```typescript
type Invariant<S extends Schema> = {
  description: string;
  valid: (state: Readonly<S>, actor?: Actor) => boolean;
};
```

**Usage:**
```typescript
import { type Invariant } from "@rotorsoft/act";

// Type S with MINIMAL fields — contravariance allows assignment to subtypes
export const mustBeOpen: Invariant<{ status: string }> = {
  description: "Item must be open",
  valid: (state) => state.status === "Open",
};

// Use in state builder
.on({ CloseItem })
  .given([mustBeOpen])
  .emit(...)
```

The `valid` function returns `true` if the rule passes, `false` if violated. When violated, the framework throws an `InvariantError` with the `description`.

## 9. Emit Handler Signature

```typescript
type ActionHandler<S, E, A, K> = (
  action: Readonly<A[K]>,           // action payload
  snapshot: Readonly<Snapshot<S>>,  // current state snapshot — destructure as { state }
  target: Target                    // { stream, actor } — destructure as { stream, actor }
) => Emitted<E> | Emitted<E>[] | undefined;

// Where Emitted is a tuple:
type Emitted<E> = [EventName, EventData];
```

**Common patterns:**
```typescript
// String passthrough — action payload becomes event data directly
.emit("TicketAssigned")

// Destructuring style
.emit((data, { state }, { actor }) => ["ItemCreated", { ...data, createdBy: actor.id }])

// Computed fields from action payload
.emit((data) => [
  "CartSubmitted",
  {
    orderedProducts: data.items,
    totalPrice: data.items.reduce((sum, item) => sum + parseFloat(item.price || "0"), 0),
  },
])

// Multiple events
.emit((data, { state }) => [
  ["ItemCreated", { name: data.name }],
  ["AuditLogged", { action: "create" }],
])

// Conditional emit
.emit((data, { state }) => {
  if (state.count > 10) return ["LimitReached", {}];
  return ["Incremented", { amount: data.by }];
})
```

**Parameters:**
1. `action` — The validated action payload (the Zod-parsed input)
2. `snapshot` — Has `.state` (current state), `.patches` (event count), `.snaps` (snapshot count), `.event` (last event)
3. `target` — Has `.stream` (stream ID), `.actor` (actor object with `.id` and `.name`, plus any fields from `withActor<T>()`)

## 10. store().seed() — Test Isolation

```typescript
import { store, dispose } from "@rotorsoft/act";

beforeEach(async () => {
  await store().seed();
  clearItems();           // also reset in-memory projections
  clearUsers();           // each projection needs its own clear
});

afterAll(async () => {
  await dispose()();      // disposes all adapters (store, cache, etc.)
});
```

`seed()` initializes or resets the store. For InMemoryStore, call it in `beforeEach` (or `beforeAll`) to ensure a clean state between tests. For PostgresStore, it creates necessary tables and indexes. `dispose()()` cleans up all registered adapters (store, cache, and any custom disposers) — the cache is cleared automatically during disposal.

**Projection cleanup**: In-memory projections (Maps, arrays) persist across tests. Export `clear*()` functions from each projection module and call them in `beforeEach` alongside `store().seed()`.

```typescript
// In projection module
const items = new Map<string, ItemView>();

export function clearItems() { items.clear(); }

// In test file
beforeEach(async () => {
  await store().seed();
  clearItems();
  clearOrders();
  clearUsers();
});

afterAll(async () => {
  await dispose()();  // cleans up store, cache, and all adapters
});
```

**Port pattern:** `store()` and `cache()` return the current adapters (defaults to InMemoryStore and InMemoryCache). To switch adapters:
```typescript
import { store, cache } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({ /* config */ }));  // sets the store adapter
await store().seed();                         // initializes it

// For distributed deployments, replace the cache:
cache(new RedisCache({ /* config */ }));      // sets the cache adapter
```

## 11. Cache Port — Always-On State Caching

Cache is always-on with `InMemoryCache` (LRU, maxSize 1000) as the default. It stores the latest state checkpoint per stream, eliminating full event replay on every `load()`.

**How it works:**
- `load()` checks `cache().get(stream)` first — on hit, only events after the cached position are replayed
- `action()` updates the cache after every successful commit (`cache().set()`)
- On `ConcurrencyError`, the stale cache entry is invalidated (`cache().invalidate()`)

**Cache vs Snapshots:**
- **Cache** (in-memory) — checked first on every `load()`. Eliminates store round-trips entirely on warm hits.
- **Snapshots** (in-store as `__snapshot__` events) — fallback on cache miss (cold start, LRU eviction, process restart). Avoids replaying the entire event stream.

```typescript
import { cache } from "@rotorsoft/act";

// Cache is active by default — no setup needed
// load() and action() use it transparently

// For distributed deployments, replace with a custom adapter:
cache(new RedisCache({ url: "redis://localhost:6379" }));
```

The `Cache` interface is async for forward-compatibility with external caches (Redis, Memcached, etc.):

```typescript
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
```

## 12. Projection Builder

Projections are read-model updaters that react to events and update external state (databases, caches, etc.). Unlike slices, projections have no states and handlers do not receive a `Dispatcher`.

```typescript
import { projection } from "@rotorsoft/act";

const ItemProjection = projection("items")
  .on({ ItemCreated })
    .do(async ({ stream, data }) => {
      items.set(stream, { name: data.name, status: "Open" });
    })
  .on({ ItemClosed })
    .do(async ({ stream, data }) => {
      const item = items.get(stream);
      if (item) item.status = "Closed";
    })
  .build();
```

**API:**
- `projection(target?)` — Creates a builder; optional default target stream
- `.on({ EventName: schema })` — Register an event handler (record shorthand)
- `.do(handler)` — Handler receives `(event, stream)` — no Dispatcher
- `.to(resolver)` / `.void()` — Override the default resolver per handler
- `.build()` — Returns a `Projection` with `_tag: "Projection"`

## 13. Slice Builder — Vertical Slice Architecture

Slices group partial states with scoped reactions into self-contained feature modules. Handlers receive a typed `Dispatcher` for cross-state action dispatch.

```typescript
import { slice } from "@rotorsoft/act";

const ItemSlice = slice()
  .withState(Item)
  .withProjection(ItemProjection)  // embed projection (events must be subset of slice events)
  .on("ItemCreated")  // plain string, NOT record shorthand
    .do(async (event, stream, app) => {
      // app is a typed Dispatcher — use for cross-state actions
      await app.do("SomeAction", { stream, actor: systemActor }, payload, event);
    })
    .to((event) => ({ target: event.stream }))
  .build();
```

**API:**
- `slice()` — Creates a builder
- `.withState(state)` — Register a partial state
- `.withProjection(proj)` — Embed a built Projection (events must be a subset of slice events)
- `.on(eventName)` — React to an event (string, not record)
- `.do(handler)` — Handler receives `(event, stream, app)` where `app` is a `Dispatcher`
- `.to(resolver)` / `.void()` — Set target stream resolver
- `.build()` — Returns a `Slice` with `_tag: "Slice"`

**Important:** `.void()` reactions are **never processed by `drain()`**. Use `.to(resolver)` for any reaction that must be discovered and executed during drain.
