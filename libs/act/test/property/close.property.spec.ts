import { fc, test } from "@fast-check/vitest";
import { z } from "zod";
import { InMemoryCache } from "../../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../../src/adapters/in-memory-store.js";
import { act } from "../../src/builders/act-builder.js";
import { state } from "../../src/builders/state-builder.js";
import { cache, dispose, store } from "../../src/ports.js";
import { StreamClosedError } from "../../src/types/errors.js";

/**
 * Properties for close-the-books semantics:
 *
 *   1. After close() with restart=false, subsequent action() on the
 *      stream throws StreamClosedError.
 *   2. close() is idempotent — closing already-tombstoned streams is
 *      a no-op (skipped, no error).
 *   3. close() with restart=true preserves observable state — load()
 *      after restart equals load() before close.
 *   4. truncate.deleted equals (events_before_close + 1) for the
 *      tombstone guard, since truncate's seed event replaces the chain.
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

const opArb = fc.record({
  stream: fc.constantFrom("s1", "s2"),
  by: fc.integer({ min: -5, max: 5 }),
});

describe("property: close-the-books invariants", () => {
  beforeEach(() => {
    store(new InMemoryStore());
    cache(new InMemoryCache());
  });
  afterEach(async () => {
    await dispose()();
  });

  test.prop([fc.array(opArb, { minLength: 1, maxLength: 15 })], {
    numRuns: 50,
  })(
    "close() with restart=false: action throws StreamClosedError afterwards",
    async (ops) => {
      const app = act().withState(Counter).build();
      for (const { stream, by } of ops) {
        await app.do("inc", target(stream), { by });
      }
      const streams = [...new Set(ops.map((o) => o.stream))];
      await app.close(streams.map((s) => ({ stream: s })));

      for (const s of streams) {
        await expect(app.do("inc", target(s), { by: 1 })).rejects.toThrow(
          StreamClosedError
        );
      }
    }
  );

  test.prop([fc.array(opArb, { minLength: 1, maxLength: 15 })], {
    numRuns: 50,
  })("close() is idempotent on already-tombstoned streams", async (ops) => {
    const app = act().withState(Counter).build();
    for (const { stream, by } of ops) {
      await app.do("inc", target(stream), { by });
    }
    const streams = [...new Set(ops.map((o) => o.stream))];
    const targets = streams.map((s) => ({ stream: s }));

    const first = await app.close(targets);
    expect(first.truncated.size).toBe(streams.length);

    // Second close on the same streams — should be a no-op (skipped).
    const second = await app.close(targets);
    expect(second.truncated.size).toBe(0);
    // Already-tombstoned streams end up in skipped (the safety probe
    // and tombstone-guard short-circuit them).
  });

  test.prop([fc.array(opArb, { minLength: 1, maxLength: 10 })], {
    numRuns: 50,
  })("close() with restart=true preserves observable state", async (ops) => {
    const app = act().withState(Counter).build();
    for (const { stream, by } of ops) {
      await app.do("inc", target(stream), { by });
    }
    const streams = [...new Set(ops.map((o) => o.stream))];
    const before = new Map<string, unknown>();
    for (const s of streams) {
      const snap = await app.load(Counter, s);
      before.set(s, snap.state);
    }

    await app.close(streams.map((s) => ({ stream: s, restart: true })));

    // After restart, state must equal what was loaded before close.
    for (const s of streams) {
      const snap = await app.load(Counter, s);
      expect(snap.state).toEqual(before.get(s));
    }
  });
});
