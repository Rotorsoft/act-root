import { z } from "zod";
import type { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { state } from "../src/builders/state-builder.js";
import { action, load } from "../src/internal/event-sourcing.js";
import { cache, dispose, log, store } from "../src/ports.js";
import type { Cache } from "../src/types/index.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .build();

// A guarded counter whose action fails an invariant once count reaches 5.
// Used to exercise the post-load / pre-commit failure path that must NOT
// invalidate the warm cache.
const Guarded = state({ Guarded: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Bumped: z.object({ by: z.number() }) })
  .patch({
    Bumped: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ bump: z.object({ by: z.number() }) })
  .given([
    { description: "count must stay below 5", valid: (s) => s.count < 5 },
  ])
  .emit((a) => ["Bumped", { by: a.by }])
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
    await action(Counter, "increment", target, { count: 5 });

    // Load should populate cache
    const snap = await load(Counter, { stream: "c1" });
    expect(snap.state.count).toBe(5);

    // Second load should use cache (partial replay with 0 new events)
    const snap2 = await load(Counter, { stream: "c1" });
    expect(snap2.state.count).toBe(5);
    expect(snap2.patches).toBe(1);
  });

  it("action updates cache", async () => {
    await action(Counter, "increment", target, { count: 3 });
    await action(Counter, "increment", target, { count: 7 });

    // Cache should have latest state from the action
    const c = cache() as InMemoryCache;
    const entry = await c.get("c1");
    expect(entry?.state).toEqual({ count: 10 });
    expect(entry?.patches).toBe(2);
  });

  it("cached load returns correct state after multiple actions", async () => {
    for (let i = 1; i <= 10; i++) {
      await action(Counter, "increment", target, { count: 1 });
    }
    const snap = await load(Counter, { stream: "c1" });
    expect(snap.state.count).toBe(10);
    expect(snap.patches).toBe(10);
  });

  it("cache invalidated on ConcurrencyError", async () => {
    await action(Counter, "increment", target, { count: 1 });

    // Force a concurrency error by using wrong expectedVersion
    try {
      await action(
        Counter,
        "increment",
        { ...target, expectedVersion: 999 },
        { count: 1 }
      );
    } catch {
      // expected
    }

    // Cache should be invalidated
    const c = cache() as InMemoryCache;
    const entry = await c.get("c1");
    expect(entry).toBeUndefined();
  });

  // Narrow-invalidation contract (cache-and-snapshots.md):
  // "Anything else — handler errors, validation errors, schema failures —
  // leaves the cache untouched. The cache reflects committed state; if no
  // commit happened, no invalidation needed." Only ConcurrencyError (above)
  // invalidates. These two cases pin the negative half of the contract.
  it("invariant failure leaves the warm cache untouched (no commit)", async () => {
    await action(Guarded, "bump", target, { by: 4 });
    await action(Guarded, "bump", target, { by: 1 }); // count = 5, cache warm

    const c = cache() as InMemoryCache;
    expect((await c.get("c1"))?.state).toEqual({ count: 5 });

    // count is now 5 → invariant "count must stay below 5" fails on load,
    // before any commit. The cache must survive unchanged.
    await expect(action(Guarded, "bump", target, { by: 1 })).rejects.toThrow();

    expect((await c.get("c1"))?.state).toEqual({ count: 5 });
  });

  it("validation failure leaves the warm cache untouched (no commit)", async () => {
    await action(Counter, "increment", target, { count: 5 }); // cache warm

    const c = cache() as InMemoryCache;
    expect((await c.get("c1"))?.state).toEqual({ count: 5 });

    // Invalid payload — schema validation throws before any commit.
    await expect(
      action(Counter, "increment", target, { count: "nope" } as never)
    ).rejects.toThrow();

    expect((await c.get("c1"))?.state).toEqual({ count: 5 });
  });

  it("cache.set rejection is logged but does not fail the action", async () => {
    // Reset singletons so we can inject a failing cache for this test only
    await dispose()();
    store(new InMemoryStore());
    await store().seed();

    const setError = new Error("simulated cache write failure");
    const failingCache: Cache = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(setError),
      invalidate: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    };
    cache(failingCache);

    const errorSpy = vi.spyOn(log(), "error").mockImplementation(() => {});

    // Action should succeed despite cache.set rejecting
    const snaps = await action(Counter, "increment", target, { count: 5 });
    expect(snaps[0].state.count).toBe(5);

    // Flush the fire-and-forget .catch microtask
    await new Promise((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalledWith(setError);
    errorSpy.mockRestore();
  });
});
