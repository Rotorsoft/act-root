import { z } from "zod";
import { InMemoryCache } from "../src/adapters/InMemoryCache.js";
import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { action, load } from "../src/event-sourcing.js";
import { cache, dispose, store } from "../src/ports.js";
import { state } from "../src/state-builder.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .build();

const target = { stream: "c1", actor: { id: "a", name: "a" } };

describe("cache integration", () => {
  beforeEach(async () => {
    store(new InMemoryStore());
    // cache is always-on (InMemoryCache default)
    await store().seed();
  });

  afterEach(async () => {
    await dispose()();
  });

  it("cache miss populates cache on load", async () => {
    // Commit an event directly
    await action(Counter, "increment", target, { count: 5 }, undefined, true);

    // Load should populate cache
    const snap = await load(Counter, "c1");
    expect(snap.state.count).toBe(5);

    // Second load should use cache (partial replay with 0 new events)
    const snap2 = await load(Counter, "c1");
    expect(snap2.state.count).toBe(5);
    expect(snap2.patches).toBe(1);
  });

  it("action updates cache", async () => {
    await action(Counter, "increment", target, { count: 3 }, undefined, true);
    await action(Counter, "increment", target, { count: 7 }, undefined, true);

    // Cache should have latest state from the action
    const c = cache() as InMemoryCache;
    const entry = await c.get("c1");
    expect(entry?.state).toEqual({ count: 10 });
    expect(entry?.patches).toBe(2);
  });

  it("cached load returns correct state after multiple actions", async () => {
    for (let i = 1; i <= 10; i++) {
      await action(Counter, "increment", target, { count: 1 }, undefined, true);
    }
    const snap = await load(Counter, "c1");
    expect(snap.state.count).toBe(10);
    expect(snap.patches).toBe(10);
  });

  it("cache invalidated on ConcurrencyError", async () => {
    await action(Counter, "increment", target, { count: 1 }, undefined, true);

    // Force a concurrency error by using wrong expectedVersion
    try {
      await action(
        Counter,
        "increment",
        { ...target, expectedVersion: 999 },
        { count: 1 },
        undefined,
        true
      );
    } catch {
      // expected
    }

    // Cache should be invalidated
    const c = cache() as InMemoryCache;
    const entry = await c.get("c1");
    expect(entry).toBeUndefined();
  });
});
