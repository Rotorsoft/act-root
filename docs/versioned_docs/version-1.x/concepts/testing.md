---
id: testing
title: Testing
---

# Testing

Act is designed for testability. The in-memory defaults (InMemoryStore, InMemoryCache) make tests fast and isolated with zero infrastructure.

## The canonical pattern — `fixture` and `sandbox`

Reach for the helpers from `@rotorsoft/act/test` first. They build on `ActOptions.scoped` (ACT-501) so every test gets its own `{ store, cache }` bag — no singleton contention, parallel-safe with `it.concurrent`.

```typescript
import { act, type Target } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { Counter } from "../src/index.js";

const actor = { id: "user-1", name: "Test" };
const target = (stream = crypto.randomUUID()): Target => ({ stream, actor });

// Build the blueprint once at module scope — same builder, N tests.
const test = fixture(act().withState(Counter));

describe("Counter", () => {
  test("should increment", async ({ app }) => {
    const t = target();
    await app.do("increment", t, { by: 5 });

    const snap = await app.load(Counter, t.stream);
    expect(snap.state.count).toBe(5);
  });
});
```

No `beforeEach(store().seed())`, no `afterAll(dispose()())` — vitest's fixture lifecycle wires construction and teardown for you.

### Two helpers, one abstraction

| Helper | Returns | When to reach for it |
|---|---|---|
| `fixture(builder, options?)` | A vitest `test` with an `app` fixture | The 90% case: one isolated Act per test, declarative, auto-cleanup |
| `sandbox(builder, options?)` | `Promise<{ app, store, cache, dispose }>` | The escape hatch: multi-Act tests, `beforeAll`-shared setup, direct access to the store/cache handles |

`fixture` is built on top of `sandbox`. Use `fixture` unless you need imperative control.

### `sandbox` for tests that need two Acts or shared setup

```typescript
import { sandbox } from "@rotorsoft/act/test";

it("two scoped Acts in one test — no cross-talk", async () => {
  const a = await sandbox(act().withState(Counter));
  const b = await sandbox(act().withState(Counter));

  await a.app.do("increment", { stream: "c", actor }, { by: 10 });
  await b.app.do("increment", { stream: "c", actor }, { by: 3 });

  expect((await a.app.load(Counter, "c")).state.count).toBe(10);
  expect((await b.app.load(Counter, "c")).state.count).toBe(3);

  await a.dispose();
  await b.dispose();
});
```

For PG- or SQLite-backed tests, pass a custom store factory:

```typescript
const test = fixture(builder, {
  store: () => new PostgresStore({ schema: `t_${nanoid()}` }),
});
```

Each test gets its own per-schema PG store, and `dispose` tears down the pool.

### Parallel-safe `test.concurrent`

Because each fixture instance gets its own store and cache, `test.concurrent` is safe out of the box:

```typescript
const test = fixture(builder);

test.concurrent("A", async ({ app }) => {
  await app.do("increment", { stream: "x", actor }, { by: 10 });
  expect((await app.load(Counter, "x")).state.count).toBe(10);
});

test.concurrent("B", async ({ app }) => {
  await app.do("increment", { stream: "x", actor }, { by: 99 });
  expect((await app.load(Counter, "x")).state.count).toBe(99);
});
```

No singleton contention; both tests can run interleaved on the same worker.

## Legacy pattern (singleton store, singleton dispose)

Tests that predate the `fixture` / `sandbox` helpers use the singleton store directly. The pattern still works and is the only option for tests that exercise the singleton port mechanism itself (e.g., `ports.spec.ts`, `cache.spec.ts`):

```typescript
import { store, dispose } from "@rotorsoft/act";

describe("Counter (legacy)", () => {
  beforeEach(async () => {
    await store().seed();       // reset event store
  });

  afterAll(async () => {
    await dispose()();          // tear down singletons
  });

  it("...", async () => { /* ... */ });
});
```

### Why `store().seed()` in `beforeEach`?

`seed()` resets the event store to a clean state. For InMemoryStore this is a no-op (events are cleared on `drop()`). For PostgresStore it creates tables and indexes.

### Why `dispose()()` in `afterAll`?

`dispose()()` calls `.dispose()` on every registered adapter (store, cache, and any custom disposers) in reverse registration order. This ensures clean teardown — the cache is cleared, connections are closed, timers are stopped.

## Testing Actions and State

```typescript
it("should increment", async () => {
  const t = target();
  await app.do("increment", t, { by: 5 });

  const snap = await app.load(Counter, t.stream);
  expect(snap.state.count).toBe(5);
});

it("should accumulate events", async () => {
  const t = target();
  await app.do("increment", t, { by: 3 });
  await app.do("increment", t, { by: 7 });

  const snap = await app.load(Counter, t.stream);
  expect(snap.state.count).toBe(10);
  expect(snap.patches).toBe(2);
});
```

## Testing Invariants

```typescript
it("should reject closing a non-open ticket", async () => {
  const t = target();
  // Ticket doesn't exist yet — status is not "open"
  await expect(
    app.do("CloseTicket", t, { reason: "Done" })
  ).rejects.toThrow("Ticket must be open");
});

it("should enforce business rules", async () => {
  const t = target();
  await app.do("OpenTicket", t, { title: "Bug" });
  await app.do("CloseTicket", t, { reason: "Fixed" });

  // Can't close twice
  await expect(
    app.do("CloseTicket", t, { reason: "Again" })
  ).rejects.toThrow();
});
```

## Testing Reactions and Projections

Reactions don't run as part of `app.do()` — they're processed by `drain()` after the orchestrator has discovered new target streams via `correlate()`. The two are explicit in tests so the test controls exactly when reactions fire.

```typescript
it("should process reactions", async () => {
  const t = target();
  await app.do("CreateItem", t, { name: "Test" });

  await app.correlate();   // discover reaction target streams
  await app.drain();       // process them

  const items = getItems();
  expect(items[t.stream]).toBeDefined();
  expect(items[t.stream].name).toBe("Test");
});
```

For multi-hop reaction chains, repeat `correlate → drain` until a pass produces no work. `settle()` exists for production (debounced, non-blocking), but tests stick to the explicit pair to keep the cycle count deterministic and assertions easy to time.

### Projection Cleanup

In-memory projections (Maps, arrays) persist across tests. Export `clear*()` functions:

```typescript
// In projection module
const items = new Map<string, ItemView>();

export function clearItems() { items.clear(); }

// In test setup
beforeEach(async () => {
  await store().seed();
  clearItems();
});
```

## Testing Events Directly

Query the event log to verify what was emitted:

```typescript
it("should emit correct events", async () => {
  const t = target();
  await app.do("increment", t, { by: 5 });

  const events = await app.query_array({ stream: t.stream });
  expect(events).toHaveLength(1);
  expect(events[0].name).toBe("Incremented");
  expect(events[0].data).toEqual({ amount: 5 });
});
```

## Testing Concurrency

```typescript
it("should detect concurrent modifications", async () => {
  const t = target();
  await app.do("increment", t, { by: 1 });

  // Load state at version 0
  const snap = await app.load(Counter, t.stream);

  // Another process modifies the stream
  await app.do("increment", t, { by: 1 });

  // Attempt to commit with stale version
  await expect(
    app.do("increment", { ...t, expectedVersion: snap.event?.version }, { by: 1 })
  ).rejects.toThrow();
});
```

## Tips

- Use `crypto.randomUUID()` for stream IDs to isolate tests from each other
- Test both happy paths and error cases (invariants, validation, concurrency)
- For complex reaction chains, call `correlate()` → `drain()` in a loop
- Never test against projections in the hot path — use `app.load()` for authoritative state
