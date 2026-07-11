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

// Combine multiple states (useful for typed IAct construction)
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

## 5b. No Redundant Timestamps in Events

Every committed event has a `created` timestamp provided by the framework (`event.created: Date`). Do NOT add timestamp fields like `createdAt`, `updatedAt`, `openedAt`, `closedAt`, `removedAt`, `registeredAt`, or `addedAt` to event schemas — they duplicate `event.created`.

**Only include dates that represent business dates** distinct from when the event was recorded. For example, a `transaction_date` for a stock trade that happened on a different day than when it was entered into the system.

```typescript
// ❌ Don't do this — redundant with event.created
export const ItemCreated = z.object({ name: z.string(), createdAt: z.string() });

// ✅ Do this — no timestamp, use event.created in projections
export const ItemCreated = z.object({ name: z.string(), createdBy: z.string() });

// ✅ Business date that differs from event creation
export const LotAdded = z.object({ ticker: z.string(), lot: Lot });
// where Lot has transaction_date: z.string() — the actual trade date
```

In projections, use `event.created` for the timestamp:
```typescript
.on({ ItemCreated })
.do(async (event) => {
  await db().insert(items).values({
    id: event.stream,
    name: event.data.name,
    createdAt: event.created.toISOString(), // from framework, not event data
  });
})
```

**Aggregations by business date must read the payload, not `event.created`.** `event.created` is the *insert* time, not the business date. If you backdate, seed historical data, or replay through a reaction that re-emits, `event.created` no longer matches the business date and aggregations land in the wrong bucket (e.g., a Q1 payment seeded today buckets into the current quarter). When designing an event, ask "which dates do consumers need?" — anything other than "the moment it was logged" goes in the payload explicitly. In the aggregator, prefer `data.businessDate ?? event.created`.

## 5c. Events Store Facts, Not Derived Totals

Event payloads describe what *happened* — the inputs, not the resulting totals. Anything calculable from other fields (in the same payload OR by combining payload with prior state) belongs in the patch handler / projection / view, not on the event itself.

**Why:**
- **Drift** — if rounding or a rule changes, every old event ships the wrong frozen total. Recompute on apply gives one consistent answer everywhere.
- **Audit honesty** — `amount=$100, taxDeductiblePercent=50%` is two facts; `deductibleAmount=$50` looks like a third independent fact when it's just the first two multiplied.
- **Replay correctness** — when projections rebuild, they recompute from facts. A stored derived value can't be updated by the rebuild.
- **Wire/storage size** — sending the full collection (or pre-computed sums) on every adjust is noise.

```typescript
// ❌ Wrong — `newTotal` is derived from prior state + amount
export const GrossIncomeUpdated = z.object({
  amount: z.number(),
  invoiceStream: z.string(),
  newTotal: z.number(),  // = state.grossIncome + amount, recompute in patch
});

// ❌ Wrong — `deductibleAmount` is amount × pct/100
export const ExpenseAdded = z.object({
  amount: z.number(),
  deductibleAmount: z.number(),  // computable from amount + pct
});

// ❌ Wrong — `totalHours` and `amount` are derived from `entries × rate`
export const InvoiceCreated = z.object({
  entries: z.record(z.string(), DayEntry),
  rate: z.number(),
  totalHours: z.number(),  // = sum(entries[].hours)
  amount: z.number(),       // = totalHours × rate
});

// ✅ Right — facts only
export const GrossIncomeUpdated = z.object({ amount: z.number(), invoiceStream: z.string() });
export const ExpenseAdded = z.object({ amount: z.number(), taxDeductiblePercent: z.number() });
export const InvoiceCreated = z.object({ entries: z.record(z.string(), DayEntry), rate: z.number() });

// Patch handler does the math:
.patch({
  GrossIncomeUpdated: ({ data }, s) => ({ grossIncome: s.grossIncome + data.amount }),
  ExpenseAdded: ({ data }, s) => {
    const deductibleAmount = data.amount * (data.taxDeductiblePercent / 100);
    return { expenses: { ...s.expenses, [data.id]: { ...data, deductibleAmount } } };
  },
  InvoiceCreated: ({ data }) => {
    const totalHours = Object.values(data.entries).reduce((sum, e) => sum + e.hours, 0);
    return { entries: data.entries, totalHours, amount: totalHours * data.rate, /* ... */ };
  },
})
```

The aggregate's `state` schema CAN carry derived caches (e.g. `state.expense.deductibleAmount`) because state is a projection — patch handlers refresh the cache on every apply. **Events themselves stay lean.**

**Collections: send keyed deltas, not the full collection.** When one element of a Record/Array changes, the action and event should carry only that change keyed by id, with a sentinel for deletes. Replacing the whole collection on every update bloats the event log and loses the *intent* of the change.

```typescript
// ❌ Wrong — sends the whole entries map every time, even when one day changed
export const AdjustInvoice = z.object({
  entries: z.record(z.string(), DayEntry).optional(),
});

// ✅ Right — delta keyed by date; null = delete
export const AdjustInvoice = z.object({
  entriesPatch: z.record(z.string(), DayEntry.nullable()).optional(),
});

// Caller computes the delta with `delta(before, after)` and the patch handler
// applies it with `patch(state, eventData)`. No hand-rolled diff/merge logic.
import { delta, patch } from "@rotorsoft/act-patch";

const entriesPatch = delta(currentEntries, newEntries);
if (Object.keys(entriesPatch).length > 0) {
  await trpc.adjustInvoice.mutate({ stream, entriesPatch });
}

// Patch handler merges via `patch`:
.patch({
  InvoiceAdjusted: ({ data }, s) => ({
    entries: patch(s.entries, data.entriesPatch ?? {}),
  }),
})
```

`delta` and `patch` form a closed bidirectional algebra over `Patch<S>`: any event whose payload is a `Patch<S>` over the aggregate's state shape can be produced by the caller via `delta` and applied by the patch handler via `patch`. Naive diffs (`JSON.stringify` comparisons, missed deletions, `Date` reference inequality) are bug-prone — `delta` mirrors `patch`'s replacement rules so the round-trip identity holds: `patch(before, delta(before, after)) ≡ after`.

**Projections that need derived totals** can either compute from event facts (when the event has everything — e.g. `InvoiceCreated.entries`) OR `app.load(state, stream)` to read post-apply totals (when the event only carries a delta — e.g. `InvoiceAdjusted`). Lazy-import `app` from bootstrap to avoid circular deps:

```typescript
.on({ InvoiceAdjusted })
.do(async function adjusted({ stream, data }) {
  if (data.entriesPatch || data.rate !== undefined) {
    const { app } = await import("../bootstrap.js");
    const { Invoice } = await import("../states/index.js");
    const snap = await app.load(Invoice, stream);
    set.hours = snap.state.totalHours;
    set.amount = snap.state.amount;
  }
  // ...
})
```

**How to spot it during code review:**
- Any event field whose value the emit handler computed from other event fields → drop it.
- Any event field whose value the emit handler computed from `state.X + data.Y` → drop it.
- Any event payload that includes the full collection when only one element changed → switch to keyed-delta with null-as-delete.

**EXCEPTION: snapshot environmental values that can change over time.** The "events store facts only" rule does NOT mean "drop anything that's technically derivable." If a value comes from outside the aggregate — a config file, a related aggregate's mutable state, an external lookup table — and that source can change between emit and replay, the value must be SNAPSHOTTED on the event. Recomputing on apply would silently rewrite history.

Examples of environmental values to snapshot on the event:
- **Tax/regulatory rates** — `ratePerMile = getTaxValues(year).mileageRate`. tax-config files get edited (mid-year corrections, year-end updates); old events must keep their original rate.
- **Client snapshot fields on an invoice** — `clientName`, `clientAddress`, `commuteMiles`, `paymentInstructions`. The Client aggregate is mutable; if you re-derive these at apply time, an old invoice would suddenly show the client's current address, not the address that was on the invoice when sent.
- **Hourly rate at billing time** — even though `Client.hourlyRate` is queryable, the invoice freezes the rate that was in effect when it was created.
- **Exchange rates, discount tiers, feature-flag values, plan-tier pricing** at the moment of the action.

```typescript
// ❌ Wrong — re-lookup at apply time. tax-config can change between
//    emit and a future replay; a corrected mileage rate would silently
//    change the deduction on every old event in the log.
.patch({
  MileageAdded: ({ data }) => {
    const rate = getTaxValues(year(data.date)).mileageRate;
    const deduction = data.miles * rate;
    // ...
  },
})

// ✅ Right — snapshot the rate on the event at emit time
.on({ AddMileage })
.emit((data) => {
  const ratePerMile = getTaxValues(year(data.date)).mileageRate;
  return ["MileageAdded", { ...data, ratePerMile }];
})
.patch({
  MileageAdded: ({ data }) => {
    const deduction = data.miles * data.ratePerMile; // uses snapshot
    // ...
  },
})
```

The decision tree:
1. Is the value computable from other fields **in the same payload**? → Drop it (e.g. `deductibleAmount = amount × pct`, `totalHours = sum(entries)`).
2. Is it computable from **prior aggregate state** alone? → Drop it; patch handler does the math (e.g. `newTotal = state.grossIncome + amount`).
3. Does it require an **external lookup** or another **mutable aggregate**? → Snapshot it on the event.

## 6. Resolver Patterns

Every reaction requires a `.to(resolver)` to tell `drain()` which stream to process:

```typescript
.to((event) => ({ target: event.stream }))           // self-targeting
.to((event) => ({ target: event.data.targetId }))    // cross-stream
.to("fixed-stream-name")                             // static target
```

For fire-and-forget side effects (logging, metrics), use lifecycle events (`app.on("committed", ...)`) instead of reactions.

**Gotcha — don't set per-event `source` in fan-in resolvers.** The `source` field on a resolver becomes a persisted LIKE pattern in the `streams` table. `subscribe()` is `INSERT OR IGNORE` keyed on `target`, so whatever the *first* correlate persists for `source` is what `claim()` keeps using forever — every subsequent subscribe with a different source is a no-op, and `claim()`'s `WHERE stream LIKE persisted_source` filter excludes everyone else's events. The leasing/ordering layer is innocent; the source filter just never widens.

```typescript
// ❌ Wrong — first source's stream pattern locks the filter forever
.to((event) => ({ source: event.stream, target: "book-income" }))
// → row written with source="invoice-A"; payments on invoice-B/-C never match the LIKE filter

// ✅ Right — leave source unset for fan-in
.to({ target: "book-income" })
// → source=NULL; drain reads all events in id order; .on("PaymentReceived") filters by name
```

Set `source` only when you want to genuinely scope drain to a *stable* stream pattern across every firing — e.g., a singleton aggregate's own stream, or a regex like `"invoice-.*"` that's the same on every correlate. For "many sources fan into one consumer," leave `source` unset.

## 7. Correlate Before Drain — settle() Pattern

`app.correlate()` scans events, resolves reaction targets, and **registers new streams** with the store via `store().subscribe()`. Without this step, `drain()` won't find streams to process.

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
  maxPasses: Infinity,                  // kill-switch cap (default: Infinity)
  streamLimit: 10,                      // passed to drain()
  eventLimit: 100,                      // passed to drain()
});
```

**Key design:**
- **Non-blocking**: `settle()` returns immediately — mutations don't wait for drain
- **Debounced**: Multiple rapid `app.do()` calls coalesce into one settle cycle (10ms window)
- **Guarded**: Internal `_settling` flag prevents concurrent settle cycles
- **Drains to completion**: loops correlate→drain until a pass makes no progress (no new subscriptions, no acks, no blocks). Paginated catch-up after `app.reset(...)` works without a manual loop.
- **`maxPasses` is a kill-switch**, not a tuning knob — it caps runtime if a reaction handler keeps emitting events that re-trigger itself. Default `Infinity` means the natural exit always wins.
- **Lifecycle event**: `"settled"` fires only after all correlate/drain iterations finish, so SSE clients see a consistent view

**In tests:** Call `correlate()` + `drain()` directly (synchronous, no debounce):
```typescript
it("should process reactions", async () => {
  await app.do("CreateItem", target, { name: "Test" });
  await app.correlate();  // ← discovers reaction target streams
  await app.drain();      // ← now processes them
});
```

**In bootstrap:** Wire `app.on("committed", () => app.settle())` before the initial settle. This ensures reaction chains fully propagate — when a reaction produces new events during drain, the `committed` listener triggers another settle cycle to process those events through projections and further reactions. Without this, projection streams lag behind after reaction chains.

```typescript
const settleOpts = { streamLimit: 100, eventLimit: 1000 };
app.on("committed", () => app.settle(settleOpts));
```

**In API mutations:** No explicit `settle()` needed — the `committed` listener handles it automatically:
```typescript
CreateItem: authedProcedure.mutation(async ({ input, ctx }) => {
  await app.do("CreateItem", target, input);
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

**Validation that depends on action data — throw inside `.emit()`.** Invariants only see `(state, actor)`, so they cannot validate rules that combine state with the incoming action payload (e.g., "contribution amount + current ≤ §415(c) cap", "invoice must have at least one entry", "rate must be > 0"). For these, throw inside the emit handler — the action aborts and no event is committed:

```typescript
.on({ AddContribution })
.emit((data, { state }) => {
  const newTotal = state.contributed + data.amount;
  if (newTotal > state.annualCap) throw new Error(`Exceeds §415(c) cap of ${state.annualCap}`);
  return ["ContributionAdded", data];
})
```

This belongs in the aggregate (not the router/API layer) because the aggregate is the system of record. A router-level check is invisible to other callers (CLI, replays, internal `app.do()` calls) and lets bad events sneak in. Router-level throws are appropriate only for cross-aggregate constraints (need visibility into other streams), external-dependency prereqs (e.g. "no email address — can't send"), or admin-tool guards on destructive operations.

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

## 10. Test Isolation — fixture() / sandbox()

Pass the **unbuilt builder** (`act().withState(...)` without `.build()`) to `fixture` or `sandbox` from `@rotorsoft/act/test`. Each call constructs a fresh InMemoryStore + InMemoryCache, seeds the store, and builds a scoped Act — no manual `store().seed()` needed.

**`fixture(builder)` — the common case.** Returns a vitest `test` instance with an `app` fixture. Per-test isolation, auto-cleanup, and parallel-safe under `test.concurrent`:

```typescript
import { fixture } from "@rotorsoft/act/test";
import { itemBuilder, Item } from "../src/index.js";

const test = fixture(itemBuilder);

test("creates an item", async ({ app }) => {
  await app.do("CreateItem", target(), { name: "Test" });
  const snap = await app.load(Item, target().stream);
  expect(snap.state.name).toBe("Test");
});
```

**`sandbox(builder)` — `beforeAll`-shared or multi-Act setups.** Returns `{ app, store, cache, dispose }`. Use it when you need the store/cache handles or want to wire once in `beforeAll`. `dispose()` runs `app.shutdown()` + store/cache dispose and is idempotent:

```typescript
import { sandbox } from "@rotorsoft/act/test";

const { app, dispose } = await sandbox(itemBuilder);
// ...
await dispose();
```

**Projection cleanup**: In-memory projections (Maps, arrays) live outside the store, so a fresh sandbox does not reset them. Export `clear*()` functions from each projection module and call them at the start of each test (or in a `beforeEach`):

```typescript
// In projection module
const items = new Map<string, ItemView>();

export function clearItems() { items.clear(); }

// In test file
const test = fixture(itemBuilder);

test("builds the read model", async ({ app }) => {
  clearItems();
  clearOrders();
  // ... exercise app, then assert on getItems()
});
```

**Port pattern:** `store()` and `cache()` return the current singleton adapters (defaults to InMemoryStore and InMemoryCache). To switch adapters app-wide:
```typescript
import { store, cache } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { SqliteStore } from "@rotorsoft/act-sqlite";

store(new PostgresStore({ /* config */ }));  // distributed / multi-node
// or
store(new SqliteStore({ url: "file:myapp.db" }));  // embedded / single-node
await store().seed();                         // initializes it

// For distributed deployments, replace the cache:
cache(new RedisCache({ /* config */ }));      // sets the cache adapter
```

For **per-test** PG/SQLite isolation, don't touch the singleton — pass a factory to the sandbox instead, so each test gets its own fresh adapter:
```typescript
const test = fixture(itemBuilder, {
  store: () => new PostgresStore({ schema: `t_${nanoid()}` }),
});
```

Legacy `store().seed()` in `beforeEach` + `dispose()()` in `afterAll` remains valid only for tests that exercise the singleton port mechanism itself.

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

Projections are read-model updaters that react to events and update external state (databases, caches, etc.). Unlike slices, projections have no states and handlers do not receive the app interface.

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
- `.do(handler)` — Handler receives `(event, stream)` — no app interface
- `.to(resolver)` — Override the default resolver per handler
- `.batch(handler)` — Register a batch handler for bulk event processing (static-target only). Receives `ReadonlyArray<BatchEvent<TEvents>>` (discriminated union) and `stream`. When defined, always called instead of individual `.do()` handlers — even for a single event.
- `.build()` — Returns a `Projection` with `_tag: "Projection"`

**Optimization:** When using `@rotorsoft/act-http/sse` broadcast, only register handlers for lifecycle events (entity creation, deletion, membership changes). High-frequency operational events don't need projection handlers — the broadcast cache is the source of truth. This reduces drain work and DB writes by ~95%. See [server.md](server.md) § Projection Optimization Strategies.

## 13. Slice Builder — Vertical Slice Architecture

Slices group partial states with scoped reactions into self-contained feature modules. Handlers receive the full `IAct` interface for action dispatch, state loading, and event querying.

```typescript
import { slice } from "@rotorsoft/act";

const ItemSlice = slice()
  .withState(Item)
  .withProjection(ItemProjection)  // embed projection (events must be subset of slice events)
  .on("ItemCreated")  // plain string, NOT record shorthand
    .do(async (event, stream, app) => {
      // app is a scoped IAct proxy — reactingTo auto-injected for correlation
      await app.do("SomeAction", { stream, actor: systemActor }, payload);
      // To override with a custom event: app.do(action, target, payload, customEvent)
      const snapshot = await app.load(Item, stream);
      const events = await app.query_array({ stream });
    })
    .to((event) => ({ target: event.stream }))
  .build();
```

**API:**
- `slice()` — Creates a builder
- `.withState(state)` — Register a partial state
- `.withProjection(proj)` — Embed a built Projection (events must be a subset of slice events)
- `.on(eventName)` — React to an event (string, not record)
- `.do(handler)` — Handler receives `(event, stream, app)` where `app` is a scoped `IAct` proxy (do, load, query, query_array). When `app.do()` is called without `reactingTo`, the triggering event is auto-injected to maintain the correlation chain. Pass an explicit `reactingTo` to override.
- `.to(resolver)` — Set target stream resolver
- `.build()` — Returns a `Slice` with `_tag: "Slice"`

**Slice design decisions:**
- **Lifecycle slice first** — every state starts with a lifecycle slice for CRUD-like actions. It may also contain simple reaction flows.
- **One slice per reaction flow** — each serial chain (event → reaction → action → state → event → …) lives in its own slice when reaction chains grow.
- **Single state schema, multiple partials** — one Zod schema, each slice declares a partial with its own `.init()`, `.emits()`, `.patch()`, `.on()`.
- **Redeclare trigger events via `.emits()`** — when a slice reacts to an event it doesn't produce, redeclare in `.emits()`. The passthrough yields to the custom reducer from the owning partial.
- **One custom patch per event** — conflicting custom patches throw at build time. Passthroughs always yield to custom reducers.

**Important:** Every reaction requires a `.to(resolver)` to be discovered and executed during drain. For fire-and-forget side effects, use lifecycle events (`app.on("committed", ...)`) instead.

## 14. Close the Books — Stream Archival and Truncation

`app.close()` safely archives, truncates, and optionally restarts streams. It guards streams with a tombstone to block concurrent writes, archives while guarded, then atomically truncates + seeds each stream.

```typescript
const result = await app.close([
  {
    stream: "counter-1",
    restart: true,  // restart with snapshot of final state
    archive: async () => {
      const events = await app.query_array({ stream: "counter-1", stream_exact: true });
      await s3.putObject({ Key: "counter-1.json", Body: JSON.stringify(events) });
    },
  },
  { stream: "counter-2" },  // tombstoned
]);

// result: { truncated: Map<stream, {deleted, committed}>, skipped: string[] }
```

**Key types:**
- `CloseTarget` — `{ stream: string; restart?: boolean; archive?: () => Promise<void> }`
- `StreamClosedError` — thrown by `action()` when writing to a tombstoned stream
- `TOMBSTONE_EVENT` (`"__tombstone__"`) — marks a stream as permanently closed
- `CloseResult` — `{ truncated: TruncateResult, skipped: string[] }`
- `TruncateResult` — `Map<string, { deleted: number, committed: Committed }>`

**Flow:** correlate → safety check → guard (tombstone with expectedVersion) → load state (for restart) → archive → atomic truncate + seed → cache update → emit "closed"

**In tests:**
```typescript
await app.do("increment", { stream: "s1", actor }, { by: 1 });
await app.correlate();
await app.drain();
const result = await app.close([{ stream: "s1" }]);
expect(result.truncated.has("s1")).toBe(true);
await expect(app.do("increment", { stream: "s1", actor }, { by: 1 })).rejects.toThrow(StreamClosedError);
```

## 15. Projection Rebuild — Replay Events Through Updated Projections

When a projection's logic changes, reset its watermark and let `settle()` replay every event through the updated handler.

```typescript
// 1. Clear the read-model side effects (DB rows, cache, in-memory map)
await db.delete(items);
clearItems();

// 2. Reset the projection stream watermark AND arm the orchestrator's drain flag
await app.reset(["items"]);

// 3. Trigger settle — it loops correlate→drain until caught up, then emits "settled"
app.settle({ eventLimit: 1000 });
```

**Always use `app.reset(...)` — never `store().reset(...)` directly.**

Both reset the watermark, but only `app.reset(...)` raises the orchestrator's internal `_needs_drain` flag. After a settled app (no recent commits) has caught up, `_needs_drain === false` and any subsequent `drain()`/`settle()` short-circuits and returns immediately. `store().reset(...)` alone leaves the flag unchanged, so the replay never runs. `app.reset(...)` wraps the store call and arms the flag in one step:

```typescript
// libs/act/src/act.ts
async reset(streams: string[]): Promise<number> {
  const count = await store().reset(streams);
  if (count > 0 && this._reactive_events.size > 0) {
    this._needs_drain = true;
  }
  return count;
}
```

**`settle()` drains to completion by default.** The `maxPasses` cap defaults to `Infinity` — settle exits naturally when a pass makes no progress (no new subscriptions, no acks, no blocks). One `settle()` call fully catches up paginated streams of any length; the cap only acts as a kill-switch for runaway reaction loops.

**Typical production workflow:**
1. Deploy updated projection code
2. Clear projected data (truncate read-model table, flush cache)
3. `await app.reset(["projection-target"])`
4. `app.settle()` (or wait on `"settled"`) — drives the catch-up to completion

## 16. Subscription Introspection — store().query_streams()

For operational dashboards (projection lag, blocked subscriptions, in-flight leases), use `store().query_streams()` instead of opening a second DB connection or running raw SQL against the adapter-specific streams table. The method is read-only and adapter-agnostic — works against `InMemoryStore`, `SqliteStore`, and `PostgresStore`.

```typescript
const { maxEventId, count } = await store().query_streams(
  (position) => {
    // position: { stream, source?, at, retry, blocked, error, leased_by?, leased_until? }
    console.log(`${position.stream}: lag=${maxEventId - position.at}`);
  },
  {
    stream: "^projection-",   // regex by default; pass stream_exact: true for equality
    source: "user-.*",        // same regex/exact convention via source_exact
    blocked: true,             // restrict to blocked / unblocked / omit for all
    after: lastSeenStream,     // keyset cursor — pass last entry's stream for next page
    limit: 100,                // default 100
  }
);
```

**Use the keyset cursor for paging.** Dynamic reactions can register one subscription per aggregate, so the streams table can grow large. The `after` cursor (last seen stream name, lexicographic) is cheap on big tables — no `OFFSET`. To page through all positions, call repeatedly with `after = lastPage.at(-1).stream` until `count < limit`.

**Filter set is intentionally minimal.** Only what the streams table actually persists (`stream`, `source`, `blocked`). Higher-level classification ("is this a projection vs reaction?", "static vs dynamic resolver?") is an orchestrator concern — the table doesn't store kinds. Layer that on top by joining results with the orchestrator's known projections/reactions registry.
