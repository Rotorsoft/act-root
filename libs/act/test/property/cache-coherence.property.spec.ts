import { fc, test } from "@fast-check/vitest";
import { z } from "zod";
import { InMemoryCache } from "../../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../../src/adapters/in-memory-store.js";
import { state } from "../../src/builders/state-builder.js";
import { action, load } from "../../src/internal/event-sourcing.js";
import { cache, dispose, store } from "../../src/ports.js";

/**
 * Properties for cache/store coherence:
 *
 *   1. After any sequence of `action()`s on a stream, `load()` returns
 *      the same state that a fresh load (cache cleared) would return.
 *   2. ConcurrencyError invalidates the cache entry — the next load
 *      reflects the actual store state, not stale cached data.
 *   3. The version returned by `load()` always matches the highest
 *      committed event version on the stream.
 */

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Inc: z.object({ by: z.number() }) })
  .patch({ Inc: ({ data }, s) => ({ count: s.count + data.by }) })
  .on({ inc: z.object({ by: z.number() }) })
  .emit("Inc")
  .build();

const target = (stream: string) => ({
  stream,
  actor: { id: "u", name: "u" },
});

const incArb = fc.record({
  stream: fc.constantFrom("s1", "s2", "s3"),
  by: fc.integer({ min: -10, max: 10 }),
});

describe("property: cache/store coherence", () => {
  beforeEach(() => {
    store(new InMemoryStore());
    cache(new InMemoryCache());
  });
  afterEach(async () => {
    await dispose()();
  });

  test.prop([fc.array(incArb, { minLength: 0, maxLength: 25 })], {
    numRuns: 50,
  })(
    "cached load equals fresh-load (cache cleared) for every observable stream",
    async (ops) => {
      for (const { stream, by } of ops) {
        await action(Counter, "inc", target(stream), { by });
      }
      const streams = [...new Set(ops.map((o) => o.stream))];

      // Phase 1 — confirm cache is warm after action()s.
      const cached = new Map<string, Awaited<ReturnType<typeof load>>>();
      for (const s of streams) {
        const snap = await load(Counter, { stream: s });
        expect(snap.cache_hit).toBe(true);
        cached.set(s, snap);
      }

      // Phase 2 — clear once, then verify fresh reads match the cached
      // ones state-for-state and version-for-version.
      await cache().clear();
      for (const s of streams) {
        const fresh = await load(Counter, { stream: s });
        expect(fresh.cache_hit).toBe(false);
        expect(fresh.state).toEqual(cached.get(s)!.state);
        expect(fresh.version).toBe(cached.get(s)!.version);
      }
    }
  );

  test.prop([fc.array(incArb, { minLength: 1, maxLength: 15 })], {
    numRuns: 50,
  })("ConcurrencyError invalidates the cached entry", async (ops) => {
    const { stream, by } = ops[0];
    // Seed the stream + warm the cache.
    await action(Counter, "inc", target(stream), { by });
    const before = await load(Counter, { stream: stream });
    expect(before.cache_hit).toBe(true);

    // Force a ConcurrencyError by passing a deliberately stale
    // expectedVersion. action() should invalidate the cache.
    await expect(
      action(
        Counter,
        "inc",
        { ...target(stream), expectedVersion: -1 },
        { by: 99 }
      )
    ).rejects.toThrow();

    // Next load is a cache miss — entry was invalidated.
    const after = await load(Counter, { stream: stream });
    expect(after.cache_hit).toBe(false);
    expect(after.state).toEqual(before.state); // store is unchanged
  });

  test.prop([fc.array(incArb, { minLength: 1, maxLength: 15 })], {
    numRuns: 50,
  })(
    "load() populates the cache — subsequent read on same stream is a hit",
    async (ops) => {
      const { stream, by } = ops[0];
      await action(Counter, "inc", target(stream), { by });
      // Clear cache so the first load is a miss; that miss should warm
      // the cache so the second load is a hit.
      await cache().clear();
      const first = await load(Counter, { stream: stream });
      expect(first.cache_hit).toBe(false);
      const second = await load(Counter, { stream: stream });
      expect(second.cache_hit).toBe(true);
      expect(second.state).toEqual(first.state);
      expect(second.version).toBe(first.version);
    }
  );

  test.prop([fc.array(incArb, { minLength: 0, maxLength: 25 })], {
    numRuns: 50,
  })("version equals the head event's version", async (ops) => {
    for (const { stream, by } of ops) {
      await action(Counter, "inc", target(stream), { by });
    }
    for (const s of new Set(ops.map((o) => o.stream))) {
      const snap = await load(Counter, { stream: s });
      // Read events directly to find the head version.
      const events: any[] = [];
      await store().query((e) => events.push(e), {
        stream: s,
        stream_exact: true,
      });
      const headVersion = events.length
        ? events[events.length - 1].version
        : -1;
      expect(snap.version).toBe(headVersion);
    }
  });
});
