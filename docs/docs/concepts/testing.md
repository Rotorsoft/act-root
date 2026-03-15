---
id: testing
title: Testing
---

# Testing

Act is designed for testability. The in-memory defaults (InMemoryStore, InMemoryCache) make tests fast and isolated with zero infrastructure.

## Test Setup

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { store, dispose, type Target } from "@rotorsoft/act";
import { app, Counter } from "../src/index.js";

const actor = { id: "user-1", name: "Test" };
const target = (stream = crypto.randomUUID()): Target => ({ stream, actor });

describe("Counter", () => {
  beforeEach(async () => {
    await store().seed();       // reset event store
    // clearItems();            // reset in-memory projections if any
  });

  afterAll(async () => {
    await dispose()();          // clean up all adapters (store, cache, etc.)
  });
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

Reactions require `correlate()` → `drain()` to process:

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
