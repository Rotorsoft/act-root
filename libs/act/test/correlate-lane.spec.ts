import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, dispose, state, store, ZodEmpty } from "../src/index.js";

/**
 * Regression for #1255 — in the dynamic-resolver correlate scan, when two
 * reactions on the same event resolve to the same target stream with
 * different priorities, the highest-priority reaction must set the target's
 * lane (matching the subscribe-side max() invariant). The bug kept the max
 * priority but left the first-seen reaction's lane in place.
 *
 * Dynamic resolvers (function `.to`) are required: the static path rejects
 * two reactions on the same target with different lanes at build time, so
 * the collision only reaches correlate through runtime resolution.
 */
describe("correlate dynamic-resolver lane (#1255)", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: (_e, s) => ({ count: s.count + 1 }) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("the highest-priority reaction sets the target's lane", async () => {
    const app = act()
      .withState(counter)
      .withLane({ name: "fast" })
      .withLane({ name: "slow" })
      // Low priority, "fast" lane — registered first, so scanned first and
      // seeds the entry's lane.
      .on("ticked")
      .do(async function reactLow() {})
      .to(() => ({ target: "shared", priority: 1, lane: "fast" }))
      // Higher priority, "slow" lane — must win the lane, not just the priority.
      .on("ticked")
      .do(async function reactHigh() {})
      .to(() => ({ target: "shared", priority: 7, lane: "slow" }))
      .build();

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();

    let lane: string | undefined;
    let priority = -1;
    await store().query_streams((p) => {
      if (p.stream === "shared") {
        lane = p.lane;
        priority = p.priority;
      }
    });

    expect(priority).toBe(7); // max priority — already correct
    expect(lane).toBe("slow"); // the winning reaction's lane, not "fast"
  });

  // #1363: the runtime max() invariant must hold ACROSS correlate scans, not
  // only within one. A dynamic target subscribed at a low priority must be
  // re-subscribed (raising the store's priority) when a later scan resolves a
  // higher one — the `_dynamic_subscriptions` dedup used to freeze it at first discovery.
  describe("cross-scan priority upgrade (#1363)", () => {
    const tiered = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ ticked: z.object({ premium: z.boolean() }) })
      .patch({ ticked: (_e, s) => ({ count: s.count + 1 }) })
      .on({ tick: z.object({ premium: z.boolean() }) })
      .emit((a) => ["ticked", { premium: a.premium }])
      .build();

    function buildTiered() {
      return act()
        .withState(tiered)
        .withLane({ name: "fast" })
        .withLane({ name: "slow" })
        .on("ticked")
        .do(async function react() {})
        .to((e) => ({
          target: "shared",
          source: e.stream,
          priority: (e.data as { premium: boolean }).premium ? 5 : 0,
          lane: (e.data as { premium: boolean }).premium ? "slow" : "fast",
        }))
        .build();
    }

    async function sharedState(): Promise<{ priority: number; lane?: string }> {
      let priority = -1;
      let lane: string | undefined;
      await store().query_streams((p) => {
        if (p.stream === "shared") {
          priority = p.priority;
          lane = p.lane;
        }
      });
      return { priority, lane };
    }

    it("a later higher-priority scan raises the target's priority and lane", async () => {
      const app = buildTiered();
      // Scan 1: free-tier event → shared subscribed at priority 0, lane fast.
      await app.do("tick", { stream: "free", actor }, { premium: false });
      await app.correlate();
      expect(await sharedState()).toEqual({ priority: 0, lane: "fast" });

      // Scan 2: premium event to the same target → must rise to 5 / slow.
      await app.do("tick", { stream: "prem", actor }, { premium: true });
      await app.correlate();
      expect(await sharedState()).toEqual({ priority: 5, lane: "slow" });
    });

    it("a later lower-priority scan does NOT lower the target (max holds)", async () => {
      const app = buildTiered();
      // Scan 1: premium → priority 5.
      await app.do("tick", { stream: "prem", actor }, { premium: true });
      await app.correlate();
      expect((await sharedState()).priority).toBe(5);

      // Scan 2: free-tier → must stay at 5 (dedup, no downgrade).
      await app.do("tick", { stream: "free", actor }, { premium: false });
      await app.correlate();
      expect((await sharedState()).priority).toBe(5);
    });

    it("a resolver that omits priority dedups a re-seen target at default 0", async () => {
      // No `priority` field on the resolver → defaults to 0 on both scans, so
      // the second scan re-evaluates the guard (recorded is defined) and dedups.
      const app = act()
        .withState(tiered)
        .on("ticked")
        .do(async function react() {})
        .to((e) => ({ target: "shared", source: e.stream }))
        .build();

      await app.do("tick", { stream: "a", actor }, { premium: false });
      await app.correlate();
      expect((await sharedState()).priority).toBe(0);

      await app.do("tick", { stream: "b", actor }, { premium: true });
      await app.correlate();
      expect((await sharedState()).priority).toBe(0);
    });
  });

  // #1582: the +Infinity floor that keeps a static target out of the dynamic
  // path lives in the `maxSubscribedStreams` LRU, so evicting it hands the
  // next dynamic resolution a blank slate — it re-subscribes the target with
  // its own lane. A static target's lane is owned by the build-time
  // subscribe; churning dynamic targets through the LRU must not change it.
  describe("static targets survive LRU eviction (#1582)", () => {
    const pinger = state({ Pinger: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ pinged: ZodEmpty, bumped: z.object({ to: z.string() }) })
      .patch({
        pinged: (_e, s) => ({ count: s.count + 1 }),
        bumped: (_e, s) => ({ count: s.count + 1 }),
      })
      .on({ ping: ZodEmpty })
      .emit(() => ["pinged", {}])
      .on({ bump: z.object({ to: z.string() }) })
      .emit((a) => ["bumped", { to: a.to }])
      .build();

    /**
     * `ping` reacts to a STATIC target on the "slow" lane; `bump` reacts
     * through a DYNAMIC resolver to whatever target the action names, with no
     * lane of its own. Aiming a bump at "shared" is what walks the dynamic
     * path over the static target.
     */
    function buildPinger(
      maxSubscribedStreams: number,
      ran?: string[],
      onlyLanes?: ReadonlyArray<"slow">
    ) {
      return act()
        .withState(pinger)
        .withLane({ name: "slow" })
        .on("pinged")
        .do(async function ping() {
          ran?.push("ping");
        })
        .to({ target: "shared", lane: "slow" })
        .on("bumped")
        .do(async function bump() {
          ran?.push("bump");
        })
        .to((e) => ({ target: (e.data as { to: string }).to }))
        .build({ maxSubscribedStreams, onlyLanes });
    }

    async function sharedLane(): Promise<string | undefined> {
      let lane: string | undefined;
      await store().query_streams((p) => {
        if (p.stream === "shared") lane = p.lane;
      });
      return lane;
    }

    it("CONTROL — no eviction: the static target keeps its declared lane", async () => {
      const app = buildPinger(10);
      await app.do("ping", { stream: "s1", actor }, {});
      await app.correlate();
      // A dynamic target that does NOT push "shared" out of the LRU.
      await app.do("bump", { stream: "s1", actor }, { to: "d1" });
      await app.correlate();
      // A dynamic resolution onto the static target itself.
      await app.do("bump", { stream: "s1", actor }, { to: "shared" });
      await app.correlate();

      expect(await sharedLane()).toBe("slow");
    });

    it("eviction does not let a dynamic resolution re-lane a static target", async () => {
      // maxSubscribedStreams: 1 makes eviction deterministic — one dynamic
      // target is enough to push the static entry out.
      const app = buildPinger(1);
      await app.do("ping", { stream: "s1", actor }, {});
      await app.correlate();
      await app.do("bump", { stream: "s1", actor }, { to: "d1" });
      await app.correlate();
      await app.do("bump", { stream: "s1", actor }, { to: "shared" });
      await app.correlate();

      expect(await sharedLane()).toBe("slow");
    });

    it("CONTROL — no eviction: both reactions run on the slow shard", async () => {
      const ran: string[] = [];
      const app = buildPinger(10, ran, ["slow"]);
      await app.do("ping", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();
      await app.do("bump", { stream: "s1", actor }, { to: "d1" });
      await app.correlate();
      await app.drain();
      await app.do("bump", { stream: "s1", actor }, { to: "shared" });
      await app.correlate();
      await app.drain();

      expect(ran).toEqual(["ping", "bump"]);
    });

    it("eviction does not starve the static target's stream under onlyLanes", async () => {
      const ran: string[] = [];
      const app = buildPinger(1, ran, ["slow"]);
      await app.do("ping", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();
      await app.do("bump", { stream: "s1", actor }, { to: "d1" });
      await app.correlate();
      await app.drain();
      await app.do("bump", { stream: "s1", actor }, { to: "shared" });
      await app.correlate();
      await app.drain();

      expect(ran).toEqual(["ping", "bump"]);
    });

    it("CONTROL — a restart re-subscribes statics and repairs the lane", async () => {
      const app = buildPinger(1);
      await app.do("ping", { stream: "s1", actor }, {});
      await app.correlate();
      await app.do("bump", { stream: "s1", actor }, { to: "d1" });
      await app.correlate();
      await app.do("bump", { stream: "s1", actor }, { to: "shared" });
      await app.correlate();

      // A fresh Act over the same store re-subscribes its static targets.
      const restarted = buildPinger(1);
      await restarted.correlate();
      expect(await sharedLane()).toBe("slow");
    });

    it("a static target keeps its lane however many dynamic targets churn", async () => {
      const app = buildPinger(1);
      await app.do("ping", { stream: "s1", actor }, {});
      await app.correlate();
      for (let i = 0; i < 5; i++) {
        await app.do("bump", { stream: "s1", actor }, { to: `d${i}` });
        await app.correlate();
        await app.do("bump", { stream: "s1", actor }, { to: "shared" });
        await app.correlate();
        expect(await sharedLane()).toBe("slow");
      }
    });
  });
  /**
   * The dynamic twin of #1582. A dynamic target's record lives in the
   * evictable LRU, and a missing record used to read as never-seen — so a
   * later, lower-priority resolution won the lane it had already lost. The
   * LRU calls itself "a memory bound, not a correctness mechanism", which
   * was true of a target's priority (the store merges that with max) and
   * false of its lane (the store overwrote that unconditionally).
   *
   * The repair is in the store: the lane now rides the priority max, so the
   * durable row holds the invariant and forgetting cannot break it. That
   * also covers the case no LRU bound reaches — a fresh process, whose
   * records are all missing by definition.
   */
  describe("dynamic targets survive a forgotten record (#1599)", () => {
    const ranker = state({ Ranker: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({
        hied: ZodEmpty,
        loed: ZodEmpty,
        churned: z.object({ to: z.string() }),
      })
      .patch({
        hied: (_e, s) => ({ count: s.count + 1 }),
        loed: (_e, s) => ({ count: s.count + 1 }),
        churned: (_e, s) => ({ count: s.count + 1 }),
      })
      .on({ hi: ZodEmpty })
      .emit(() => ["hied", {}])
      .on({ lo: ZodEmpty })
      .emit(() => ["loed", {}])
      .on({ churn: z.object({ to: z.string() }) })
      .emit((a) => ["churned", { to: a.to }])
      .build();

    /**
     * Two dynamic reactions on one target at different ranks: the winner
     * lanes "T" fast at priority 10, the loser asks for slow at 0. `churn`
     * mints a fresh target per action so the LRU can be driven past its
     * bound on demand.
     */
    function buildRanked(
      maxSubscribedStreams: number,
      ran?: string[],
      onlyLanes?: ReadonlyArray<"fast">
    ) {
      return act()
        .withState(ranker)
        .withLane({ name: "fast" })
        .withLane({ name: "slow" })
        .on("hied")
        .do(async function hi() {
          ran?.push("hi");
        })
        .to(() => ({ target: "T", lane: "fast", priority: 10 }))
        .on("loed")
        .do(async function lo() {
          ran?.push("lo");
        })
        .to(() => ({ target: "T", lane: "slow", priority: 0 }))
        .on("churned")
        .do(async function churn() {})
        .to((e) => ({
          target: (e.data as { to: string }).to,
          lane: "fast",
          priority: 10,
        }))
        .build({ maxSubscribedStreams, onlyLanes });
    }

    async function targetLane(): Promise<string | undefined> {
      let lane: string | undefined;
      await store().query_streams((p) => {
        if (p.stream === "T") lane = p.lane;
      });
      return lane;
    }

    it("CONTROL — no eviction: the loser does not take the lane", async () => {
      const app = buildRanked(10);
      await app.do("hi", { stream: "s1", actor }, {});
      await app.correlate();
      await app.do("lo", { stream: "s1", actor }, {});
      await app.correlate();

      expect(await targetLane()).toBe("fast");
    });

    it("eviction does not let a lower-priority resolution re-lane a dynamic target", async () => {
      // maxSubscribedStreams: 1 makes eviction deterministic — one churned
      // target is enough to push "T" out of the LRU.
      const app = buildRanked(1);
      await app.do("hi", { stream: "s1", actor }, {});
      await app.correlate();
      await app.do("churn", { stream: "s1", actor }, { to: "d1" });
      await app.correlate();
      await app.do("lo", { stream: "s1", actor }, {});
      await app.correlate();

      expect(await targetLane()).toBe("fast");
    });

    it("CONTROL — no eviction: both reactions run on the fast shard", async () => {
      const ran: string[] = [];
      const app = buildRanked(10, ran, ["fast"]);
      await app.do("hi", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();
      await app.do("lo", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();

      expect(ran).toEqual(["hi", "lo"]);
    });

    it("eviction does not starve the target's stream under onlyLanes", async () => {
      const ran: string[] = [];
      const app = buildRanked(1, ran, ["fast"]);
      await app.do("hi", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();
      await app.do("churn", { stream: "s1", actor }, { to: "d1" });
      await app.correlate();
      await app.drain();
      await app.do("lo", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();

      // Re-laned to "slow", the stream is invisible to this worker: the
      // reaction that asked for "slow" does not run, and neither does
      // anything else the target carries.
      expect(ran).toEqual(["hi", "lo"]);
    });

    it("a fresh process does not re-lane a dynamic target it never recorded", async () => {
      // No eviction involved — a restart starts with an empty LRU while the
      // rows persist, so every dynamic target reads as never-seen. The bound
      // is irrelevant here, which is why the repair had to live in the store.
      const app = buildRanked(10);
      await app.do("hi", { stream: "s1", actor }, {});
      await app.correlate();

      const restarted = buildRanked(10);
      await restarted.do("lo", { stream: "s1", actor }, {});
      await restarted.correlate();

      expect(await targetLane()).toBe("fast");
    });
  });
});
