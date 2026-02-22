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

```typescript
type PatchHandler<S, E, K> = (
  event: Committed<E, K>,  // committed event — access payload via event.data
  state: Readonly<S>       // current state BEFORE this patch
) => Readonly<Patch<S>>;   // return only changed fields (partial state)
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

## 4. ZodEmpty — Empty Payload Schema

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

## 5. Void Reactions — NEVER Processed by drain()

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

## 6. Correlate Before Drain — scheduleDrain() Pattern

`app.correlate()` scans events, resolves reaction targets, and **registers new streams** with the store via `store().lease()`. Without this step, `drain()` won't find streams to process.

```typescript
// ✅ Correct — correlate discovers streams, then drain processes them
await app.correlate();
await app.drain();

// ❌ Wrong — drain has no streams to process
await app.drain();  // returns empty results
```

**scheduleDrain()** — the production pattern for API mutations. Non-blocking, debounced, signals UI only after reactions complete:

```typescript
import { EventEmitter } from "node:events";

// Event bus for SSE — only signals AFTER reactions complete
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

let drainTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;

async function executeDrain() {
  if (draining) return;       // skip if already running
  draining = true;
  try {
    for (let i = 0; i < 2; i++) {  // 2 iterations for chained reactions
      const { leased } = await app.correlate({ after: -1, limit: 100 });
      if (leased.length === 0) break;
      await app.drain({ streamLimit: 10, eventLimit: 100 });
    }
  } finally {
    draining = false;
  }
  eventBus.emit("committed");  // signal UI AFTER reactions + projections done
}

export function scheduleDrain() {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    executeDrain().catch(console.error);
  }, 10);  // 10ms debounce coalesces rapid commits
}
```

**Key design:**
- **Non-blocking**: `scheduleDrain()` returns immediately — mutations don't wait for drain
- **Debounced**: Multiple rapid `app.do()` calls coalesce into one drain cycle (10ms window)
- **Guarded**: `draining` flag prevents concurrent drain cycles
- **UI signal after completion**: `eventBus.emit("committed")` fires only after all correlate/drain iterations finish, so SSE clients see a consistent view

**In tests:** Call `correlate()` + `drain()` directly (synchronous, no debounce):
```typescript
it("should process reactions", async () => {
  await app.do("CreateItem", target, { name: "Test" });
  await app.correlate();  // ← discovers reaction target streams
  await app.drain();      // ← now processes them
});
```

**In API mutations:** Call `scheduleDrain()` and return immediately:
```typescript
CreateItem: authedProcedure.mutation(async ({ input, ctx }) => {
  await app.do("CreateItem", target, input);
  scheduleDrain();  // fire-and-forget — UI notified via SSE
  return { success: true };
});
```

**For background processing:** Use `app.start_correlations()` for periodic discovery:
```typescript
const stop = app.start_correlations({ after: 0, limit: 100 }, 5000);
```

## 7. Invariant Type

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

## 8. Emit Handler Signature

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

## 9. store().seed() — Test Isolation

```typescript
import { store } from "@rotorsoft/act";

beforeEach(async () => {
  await store().seed();
  clearItems();           // also reset in-memory projections
  clearUsers();           // each projection needs its own clear
});
```

`seed()` initializes or resets the store. For InMemoryStore, call it in `beforeEach` (or `beforeAll`) to ensure a clean state between tests. For PostgresStore, it creates necessary tables and indexes.

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
```

**Port pattern:** `store()` returns the current store adapter (defaults to InMemoryStore). To switch adapters:
```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({ /* config */ }));  // sets the adapter
await store().seed();                         // initializes it
```
