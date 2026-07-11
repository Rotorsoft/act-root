import { z } from "zod";
import { act, InMemoryCache, InMemoryStore, state } from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type { CacheEntry, Schema } from "../src/types/index.js";

/**
 * ACT-1206 — load() must not fail a read on a cache-write error.
 *
 * `load()` computes state correctly, then writes a checkpoint to the
 * cache. That write used to be unguarded (`await cache().set(...)`), so a
 * transient failure in a remote-backed Cache threw AFTER the state was
 * already correct — failing plain reads, reaction `bound_load`
 * dispatches, and the fold engine's first-sight load. The action path
 * already catch-and-logs the same write; the fix brings load() in line.
 *
 * RED on the old code (load rejects); GREEN once the write is
 * fire-and-forget: load returns the correct state and the failure is
 * logged, not thrown.
 */

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", a])
  .build();

const actor = { id: "a", name: "a" };

describe("load() cache-write error (ACT-1206)", () => {
  it("returns the correct state and swallows a failing cache.set", async () => {
    // A cache whose `set` fails once — the transient remote blip. `get`
    // stays cold so load() takes the replay-and-cache path that writes.
    let fail_next_set = false;
    let set_attempts = 0;
    class FlakyCache extends InMemoryCache {
      override async set<TState extends Schema>(
        stream: string,
        entry: CacheEntry<TState>
      ) {
        if (fail_next_set) {
          set_attempts++;
          fail_next_set = false;
          throw new Error("cache down");
        }
        return super.set(stream, entry);
      }
    }

    const ctx = await sandbox(act().withState(Counter), {
      store: () => new InMemoryStore(),
      cache: () => new FlakyCache(),
    });
    try {
      const app = ctx.app;
      // Commit an event so a cold load replays it.
      await app.do("increment", { stream: "c1", actor }, { by: 7 });
      // Cold the cache so the next load takes the replay-and-cache path
      // that writes the checkpoint (action() warmed it on commit).
      await ctx.cache.invalidate("c1");

      fail_next_set = true;
      // The read must SUCCEED with the correct state despite the failing
      // checkpoint write. On the old code this rejected.
      const snapshot = await app.load(Counter, "c1");
      expect(snapshot.state).toEqual({ count: 7 });
      expect(set_attempts).toBe(1); // the failing write path was exercised
    } finally {
      await ctx.dispose();
    }
  });
});
