import { z } from "zod";
import {
  act,
  ConcurrencyError,
  InMemoryCache,
  InMemoryStore,
  state,
} from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type {
  Committed,
  EventMeta,
  Message,
  Schemas,
} from "../src/types/index.js";

/**
 * Holds the next commit until released — deterministically lands one
 * writer's commit inside another writer's load-to-commit window, the
 * race a snapshot-isolation read gives you on a real database.
 */
class GatedStore extends InMemoryStore {
  gate?: Promise<void>;
  override async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ): Promise<Committed<E, keyof E>[]> {
    if (this.gate) {
      const g = this.gate;
      this.gate = undefined;
      await g;
    }
    return super.commit(stream, msgs, meta, expectedVersion);
  }
}

/**
 * The cache never lies: an entry's state must equal the fold of events
 * at or below its event_id. Every commit is version-guarded, so a writer
 * whose fold is stale is refused before anything is cached.
 */
describe("cache frontier integrity", () => {
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

  const fake_reacting_to = (id: number): Committed<any, any> =>
    ({
      id,
      name: "Incremented",
      stream: "elsewhere",
      version: 0,
      created: new Date(),
      data: { by: 0 },
      meta: { correlation: "c", causation: {} },
    }) as never;

  it("keeps the optimistic guard on warm cache hits", async () => {
    const ctx = await sandbox(act().withState(Counter));
    try {
      const app = ctx.app;
      // Warm the cache: the post-commit write caches state with no
      // replayed event, so a later load hits with event undefined.
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      // Two concurrent plain actions on the warm stream: both load the
      // same frontier; the slower commit must surface ConcurrencyError,
      // not silently append past events it never folded.
      const results = await Promise.allSettled([
        app.do("increment", { stream: "c1", actor }, { by: 10 }),
        app.do("increment", { stream: "c1", actor }, { by: 100 }),
      ]);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason.name).toBe(
        "ERR_CONCURRENCY"
      );
    } finally {
      await ctx.dispose();
    }
  });

  // Lands a fast reaction's commit inside a slow one's load-to-commit window.
  const race = async (
    gated: GatedStore,
    app: { do: (...args: any[]) => Promise<unknown> }
  ) => {
    await app.do("increment", { stream: "c1", actor }, { by: 1 });
    let release!: () => void;
    gated.gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = app.do(
      "increment",
      { stream: "c1", actor },
      { by: 100 },
      {
        reactingTo: fake_reacting_to(2),
      }
    );
    await new Promise((r) => setTimeout(r, 5)); // slow writer has loaded
    await app.do(
      "increment",
      { stream: "c1", actor },
      { by: 10 },
      {
        reactingTo: fake_reacting_to(1),
      }
    );
    return { slow, release };
  };

  it("logs and swallows a failing invalidate when a reaction loses the race", async () => {
    const gated = new GatedStore();
    class FaultyCache extends InMemoryCache {
      fail_next = false;
      override async invalidate(stream: string) {
        if (this.fail_next) {
          this.fail_next = false;
          throw new Error("cache down");
        }
        return super.invalidate(stream);
      }
    }
    const faulty = new FaultyCache();
    const ctx = await sandbox(act().withState(Counter), {
      store: () => gated,
      cache: () => faulty,
    });
    try {
      const { slow, release } = await race(gated, ctx.app as never);
      faulty.fail_next = true; // the loser's invalidate rejects
      release();
      // the caller hears the conflict, not the cache error
      await expect(slow).rejects.toThrow(ConcurrencyError);
    } finally {
      await ctx.dispose();
    }
  });

  it("never leaves a stale-at-head cache entry when a reaction loses the race", async () => {
    const gated = new GatedStore();
    const ctx = await sandbox(act().withState(Counter), {
      store: () => gated,
    });
    try {
      const { slow, release } = await race(gated, ctx.app as never);
      release();
      // A reaction is guarded like any action: the stale writer is refused
      // and nothing it folded reaches the store or the cache.
      await expect(slow).rejects.toThrow(ConcurrencyError);
      const truth = await ctx.app.load(Counter, "c1");
      expect(truth.state).toEqual({ count: 11 });
      const cached = await ctx.cache.get<{ count: number }>("c1");
      expect(cached?.state ?? truth.state).toEqual(truth.state);
    } finally {
      await ctx.dispose();
    }
  });
});
