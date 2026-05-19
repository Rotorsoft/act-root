import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { dispose, store } from "../src/index.js";

// Contract-level cases live in `in-memory-store-tck.spec.ts` (via the
// shared Store TCK in `@rotorsoft/act-tck`). This file only covers
// InMemory-specific implementation details that aren't part of the
// contract — adapter optimizations and edge cases.

describe("InMemoryStore (adapter-specific)", () => {
  beforeEach(async () => {
    store(new InMemoryStore());
    await store().seed();
  });

  afterEach(async () => {
    await store().drop();
    await dispose()();
  });

  it("reuses compiled regex across streams sharing the same source", async () => {
    const s = store();
    await s.commit("order-1", [{ name: "A", data: {} }], {
      correlation: "c",
      causation: {},
    });
    // Two subscribers with the same source pattern.
    await s.subscribe([
      { stream: "sub-1", source: "order-.*" },
      { stream: "sub-2", source: "order-.*" },
    ]);
    // Advance their watermarks so hasWork() does not short-circuit on at < 0.
    const first = await s.claim(2, 0, "actor", 10);
    await s.ack(first.map((l) => ({ ...l, at: 0 })));
    // Commit a fresh event so both streams have new work past their watermark.
    await s.commit("order-1", [{ name: "A", data: {} }], {
      correlation: "c",
      causation: {},
    });
    // Second claim — both streams compile the same source; the cache reuses the regex.
    const claimed = await s.claim(2, 0, "actor2", 10000);
    expect(claimed.length).toBe(2);
  });

  describe("lanes (ACT-1103)", () => {
    it("defaults lane to 'default' when subscribe omits it", async () => {
      const s = store();
      await s.subscribe([{ stream: "sub-a" }]);
      let lane: string | undefined;
      await s.query_streams(
        (p) => {
          if (p.stream === "sub-a") lane = p.lane;
        },
        { stream: "sub-a", stream_exact: true }
      );
      expect(lane).toBe("default");
    });

    it("records the lane passed to subscribe", async () => {
      const s = store();
      await s.subscribe([{ stream: "sub-slow", lane: "slow" }]);
      let lane: string | undefined;
      await s.query_streams(
        (p) => {
          if (p.stream === "sub-slow") lane = p.lane;
        },
        { stream: "sub-slow", stream_exact: true }
      );
      expect(lane).toBe("slow");
    });

    it("re-lanes on subsequent subscribe (restart-driven config change)", async () => {
      const s = store();
      await s.subscribe([{ stream: "sub-x", lane: "slow" }]);
      await s.subscribe([{ stream: "sub-x", lane: "fast" }]);
      let lane: string | undefined;
      await s.query_streams(
        (p) => {
          if (p.stream === "sub-x") lane = p.lane;
        },
        { stream: "sub-x", stream_exact: true }
      );
      expect(lane).toBe("fast");
    });

    it("filters claim() by lane when supplied", async () => {
      const s = store();
      // Two streams with work, in different lanes.
      await s.commit("order-1", [{ name: "A", data: {} }], {
        correlation: "c",
        causation: {},
      });
      await s.commit("order-2", [{ name: "A", data: {} }], {
        correlation: "c",
        causation: {},
      });
      await s.subscribe([
        { stream: "sub-default", source: "order-1" },
        { stream: "sub-slow", source: "order-2", lane: "slow" },
      ]);

      const onlySlow = await s.claim(10, 0, "w1", 1_000, "slow");
      expect(onlySlow.map((l) => l.stream)).toEqual(["sub-slow"]);
      expect(onlySlow[0]?.lane).toBe("slow");

      // No lane filter → spans both lanes.
      await s.ack(onlySlow.map((l) => ({ ...l, at: 0 })));
      const both = await s.claim(10, 0, "w2", 1_000);
      expect(both.map((l) => l.stream).sort()).toEqual([
        "sub-default",
        "sub-slow",
      ]);
    });

    it("filters query_streams by lane", async () => {
      const s = store();
      await s.subscribe([
        { stream: "a", lane: "slow" },
        { stream: "b", lane: "fast" },
        { stream: "c", lane: "slow" },
      ]);
      const seen: string[] = [];
      await s.query_streams((p) => seen.push(p.stream), { lane: "slow" });
      expect(seen.sort()).toEqual(["a", "c"]);
    });

    it("filters prioritize by lane", async () => {
      const s = store();
      await s.subscribe([
        { stream: "a", lane: "slow" },
        { stream: "b", lane: "fast" },
      ]);
      const updated = await s.prioritize({ lane: "slow" }, 7);
      expect(updated).toBe(1);

      let aPrio = 0;
      let bPrio = 0;
      await s.query_streams((p) => {
        if (p.stream === "a") aPrio = p.priority;
        if (p.stream === "b") bPrio = p.priority;
      });
      expect(aPrio).toBe(7);
      expect(bPrio).toBe(0);
    });
  });
});
