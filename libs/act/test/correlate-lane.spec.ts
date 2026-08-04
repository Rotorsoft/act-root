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
  // higher one — the `_subscribed` dedup used to freeze it at first discovery.
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
});
