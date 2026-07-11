import { z } from "zod";
import {
  act,
  InMemoryCache,
  InMemoryStore,
  projection,
  state,
} from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type { CacheEntry, Schema } from "../src/types/index.js";

/**
 * ACT-1204 — fold-engine first-sight frontier TOCTOU.
 *
 * On first sight of a stream the fold engine used to take the loaded
 * `state` from `await load(...)` but the frontier `event_id` from a
 * SEPARATE `await cache().get(stream)`. A concurrent `action()`
 * committing between those two awaits advanced the cache to a newer
 * frontier — so the fold paired the OLDER state with the NEWER event_id.
 * The `event.id > fold.event_id` guard then permanently skipped every
 * event at or below that overshot frontier, even in later drain batches:
 * the row lags head forever.
 *
 * The fix folds the frontier into the snapshot `load()` returns
 * (captured atomically with `state`) and drops the second read. This
 * test lands the racing rewarm inside the old two-read window via a
 * cache whose second `get("c1")` overshoots the frontier, then delivers
 * the missed event in a following drain batch. RED on the old code (the
 * row is stuck at the pre-race state); GREEN once the fold trusts
 * `snapshot.frontier`.
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

async function drain_to_quiescence(app: {
  correlate: () => Promise<unknown>;
  drain: (o: {
    leaseMillis: number;
    eventLimit: number;
  }) => Promise<{ acked: unknown[] }>;
}) {
  await app.correlate();
  for (;;) {
    const d = await app.drain({ leaseMillis: 10_000, eventLimit: 1_000 });
    if (d.acked.length === 0) return;
  }
}

describe("fold first-sight frontier TOCTOU (ACT-1204)", () => {
  it("does not skip events when the cache frontier moves during first-sight load", async () => {
    const table = new Map<string, CacheEntry<{ count: number }>>();
    const counters = projection("counters")
      .of(Counter)
      .flush(async (rows) => {
        for (const row of rows) table.set(row.stream, { ...row });
      })
      .build();

    const store = new InMemoryStore();

    // The cache fires a one-shot hook on the SECOND `get("c1")` — the
    // fold's separate frontier read on the OLD code (the first `get` is
    // `load()`'s own internal probe). The hook overshoots the cached
    // frontier to event_id 2 while leaving the state at count=1: exactly
    // the entry a racing writer that computed from a stale base leaves
    // behind. On the fixed code the fold issues no second read, so the
    // hook never fires and the snapshot frontier (event_id 1) stands.
    let armed = false;
    let gets = 0;
    class RacingCache extends InMemoryCache {
      override async get<TState extends Schema>(stream: string) {
        if (armed && stream === "c1") {
          gets++;
          if (gets === 2) {
            armed = false;
            // Return a frontier that overshoots the count=1 state without
            // persisting it — only the fold's separate read sees the race;
            // the shared cache stays truthful for `app.load`/`action`.
            return {
              stream: "c1",
              state: { count: 1 },
              version: 0,
              // Frontier overshoots the count=1 state to event #2's id
              // (ids are 0-based: event #1 is id 0, event #2 is id 1).
              event_id: 1,
              patches: 1,
              snaps: 0,
            } as unknown as CacheEntry<TState>;
          }
        }
        return super.get<TState>(stream);
      }
    }
    const cache = new RacingCache();

    const ctx = await sandbox(
      act().withState(Counter).withProjection(counters),
      { store: () => store, cache: () => cache }
    );
    try {
      const app = ctx.app;

      // Phase 1: only event #1 (count=1) is committed. Warm the cache to
      // its frontier so the fold's first-sight load hits warm.
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      await cache.set("c1", {
        stream: "c1",
        state: { count: 1 },
        version: 0,
        event_id: 0, // event #1 (0-based ids)
        patches: 1,
        snaps: 0,
      });
      armed = true;
      await drain_to_quiescence(app);
      armed = false; // the race window closes with phase 1

      // Phase 2: the missed event #2 (by 10) arrives in a later batch.
      // The old code, having stamped the row's frontier at event_id 2,
      // skips it (2 is not > 2). The fixed code stamped event_id 1 and
      // folds it through to head.
      await app.do("increment", { stream: "c1", actor }, { by: 10 });
      await drain_to_quiescence(app);

      const truth = await app.load(Counter, "c1");
      expect(truth.state).toEqual({ count: 11 });
      expect(table.get("c1")?.state).toEqual({ count: 11 });
    } finally {
      await ctx.dispose();
    }
  });
});
