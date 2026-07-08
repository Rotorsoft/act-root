import { z } from "zod";
import { act, InMemoryCache, InMemoryStore, state } from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type {
  Committed,
  CommittedMessage,
  EventMeta,
} from "../src/types/index.js";

/**
 * Holds the next commit until released — deterministically lands one
 * writer's commit inside another writer's load-to-commit window, the
 * race a snapshot-isolation read gives you on a real database.
 */
class GatedStore extends InMemoryStore {
  gate?: Promise<void>;
  override async commit(
    stream: string,
    msgs: CommittedMessage[],
    meta: EventMeta,
    expectedVersion?: number
  ) {
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
 * at or below its event_id. Guardless commits (reaction-driven appends,
 * or a lost optimistic guard on warm cache hits) used to write
 * post-commit entries folded from a stale base but stamped at the head
 * frontier — invisible until a warm load trusted them.
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

  it("logs and swallows a failing invalidate on the gapped path", async () => {
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
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      let release!: () => void;
      gated.gate = new Promise<void>((r) => {
        release = r;
      });
      const slow = app.do("increment", { stream: "c1", actor }, { by: 100 }, {
        reactingTo: fake_reacting_to(2),
      } as never);
      await new Promise((r) => setTimeout(r, 5));
      await app.do("increment", { stream: "c1", actor }, { by: 10 }, {
        reactingTo: fake_reacting_to(1),
      } as never);
      faulty.fail_next = true; // the gapped writer's invalidate rejects
      release();
      // the action itself must not fail on a cache maintenance error
      await expect(slow).resolves.toBeDefined();
    } finally {
      await ctx.dispose();
    }
  });

  it("never leaves a stale-at-head cache entry after guardless commits", async () => {
    const gated = new GatedStore();
    const ctx = await sandbox(act().withState(Counter), {
      store: () => gated,
    });
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      // Reaction-driven appends skip the guard by design (leases pace
      // them). Gate the slow writer's commit so the fast writer's commit
      // lands inside its load-to-commit window — the slow fold's base is
      // then one event behind its committed position.
      let release!: () => void;
      gated.gate = new Promise<void>((r) => {
        release = r;
      });
      const slow = app.do("increment", { stream: "c1", actor }, { by: 100 }, {
        reactingTo: fake_reacting_to(2),
      } as never);
      await new Promise((r) => setTimeout(r, 5)); // slow writer has loaded
      await app.do("increment", { stream: "c1", actor }, { by: 10 }, {
        reactingTo: fake_reacting_to(1),
      } as never);
      release();
      await slow;
      // The contract: a cache entry, when present, equals the fold of
      // events at or below its event_id. The gapped writer must drop
      // the checkpoint rather than cache a lie — and the next load
      // replays to truth and re-warms honestly.
      const gapped = await ctx.cache.get<{ count: number }>("c1");
      expect(gapped).toBeUndefined();
      const truth = await app.load(Counter, "c1");
      expect(truth.state).toEqual({ count: 111 });
      const rewarmed = await ctx.cache.get<{ count: number }>("c1");
      expect(rewarmed?.state).toEqual(truth.state);
      expect(rewarmed?.version).toBe(truth.version);
    } finally {
      await ctx.dispose();
    }
  });
});
