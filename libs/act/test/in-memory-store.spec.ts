import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { ConcurrencyError, dispose, SNAP_EVENT, store } from "../src/index.js";

describe("InMemoryStore", () => {
  beforeEach(async () => {
    store(new InMemoryStore());
    await store().seed();
  });

  afterEach(async () => {
    await store().drop();
    const count = await store().query(() => {});
    expect(count).toBe(0);
    await dispose()();
  });

  describe("InMemoryStore", () => {
    const stream = "B";
    const events = [
      { name: "A", data: { a: 1 } },
      { name: "B", data: { b: 2 } },
      { name: "C", data: { c: 3 } },
    ];
    const meta = {
      correlation: "1",
      causation: {
        action: { name: "A", stream, actor: { id: "1", name: "A" } },
      },
    };

    it("should throw concurrency error", async () => {
      const committed = await store().commit(stream, events, meta);
      expect(committed.length).toBe(events.length);
      try {
        await store().commit(stream, events, meta, 1);
      } catch (error) {
        expect(error).toBeInstanceOf(ConcurrencyError);
      }
      const count = await store().query(() => {});
      expect(count).toBe(events.length);
    });

    it("should filter events by stream, names, correlation, created_after, before, created_before, and limit", async () => {
      const s = store();
      const now = new Date();
      // Add events with different properties
      await s.commit(
        "S1",
        [
          { name: "A", data: { a: 1 } },
          { name: "B", data: { b: 2 } },
        ],
        { correlation: "cor1", causation: {} }
      );
      await s.commit(
        "S2",
        [
          { name: "A", data: { a: 3 } },
          { name: "C", data: { c: 4 } },
          { name: SNAP_EVENT, data: { value: "1" } },
        ],
        { correlation: "cor2", causation: {} }
      );
      // By stream
      let result: any[] = [];
      await s.query((e) => result.push(e), { stream: "S1" });
      expect(result.length).toBe(2);
      result = [];
      await s.query((e) => result.push(e), { stream: "S1", backward: true });
      expect(result.length).toBe(2);
      // By names
      result = [];
      await s.query((e) => result.push(e), { names: ["C"] });
      expect(result.length).toBe(1);
      result = [];
      await s.query((e) => result.push(e), { names: ["C"], backward: true });
      expect(result.length).toBe(1);
      // By correlation
      result = [];
      await s.query((e) => result.push(e), { correlation: "cor2" });
      expect(result.length).toBe(2);
      result = [];
      await s.query((e) => result.push(e), {
        correlation: "cor2",
        backward: true,
      });
      expect(result.length).toBe(2);
      // By created_after
      result = [];
      const after = new Date(now.getTime() - 1000);
      await s.query((e) => result.push(e), {
        stream: "S2",
        created_after: after,
      });
      expect(result.length).toBe(2);
      result = [];
      await s.query((e) => result.push(e), {
        stream: "S2",
        created_after: after,
        backward: true,
      });
      expect(result.length).toBe(2);
      result = [];
      await s.query((e) => result.push(e), {
        stream: "S2",
        created_after: new Date(),
        backward: true,
      });
      expect(result.length).toBe(0);
      // By before (id)
      result = [];
      await s.query((e) => result.push(e), { before: 2 });
      expect(result.length).toBe(2);
      result = [];
      await s.query((e) => result.push(e), { before: 2, backward: true });
      expect(result.length).toBe(2);
      // By after (id)
      result = [];
      await s.query((e) => result.push(e), { stream: "S2", after: 2 });
      expect(result.length).toBe(1);
      result = [];
      await s.query((e) => result.push(e), {
        stream: "S2",
        after: 2,
        backward: true,
      });
      expect(result.length).toBe(1);
      // By created_before
      result = [];
      const future = new Date(now.getTime() + 1000 * 60 * 60);
      await s.query((e) => result.push(e), {
        stream: "S2",
        created_before: future,
      });
      expect(result.length).toBe(2);
      result = [];
      await s.query((e) => result.push(e), {
        stream: "S2",
        created_before: future,
        backward: true,
      });
      result = [];
      await s.query((e) => result.push(e), {
        stream: "S2",
        created_before: after,
        backward: true,
      });
      expect(result.length).toBe(0);
      // By limit
      result = [];
      await s.query((e) => result.push(e), { limit: 1 });
      expect(result.length).toBe(1);
      result = [];
      await s.query((e) => result.push(e), { limit: 1, backward: true });
      expect(result.length).toBe(1);
      // By with_snaps
      await s.query((e) => result.push(e), { with_snaps: true });
      expect(result.length).toBe(6);
    });

    it("should filter by stream_exact without regex matching", async () => {
      const s = store();
      await s.commit("ticker-VT", [{ name: "A", data: { a: 1 } }], {
        correlation: "c1",
        causation: {},
      });
      await s.commit("ticker-VTI", [{ name: "A", data: { a: 2 } }], {
        correlation: "c2",
        causation: {},
      });
      await s.commit("ticker-VTV", [{ name: "A", data: { a: 3 } }], {
        correlation: "c3",
        causation: {},
      });

      // Regex match with pattern: ticker-VT. matches VTI and VTV
      let result: any[] = [];
      await s.query((e) => result.push(e), { stream: "ticker-VT." });
      expect(result.length).toBe(2); // VTI and VTV

      // Exact match: only ticker-VT
      result = [];
      await s.query((e) => result.push(e), {
        stream: "ticker-VT",
        stream_exact: true,
      });
      expect(result.length).toBe(1);
      expect(result[0].data.a).toBe(1);

      // Exact match: only ticker-VTI
      result = [];
      await s.query((e) => result.push(e), {
        stream: "ticker-VTI",
        stream_exact: true,
      });
      expect(result.length).toBe(1);
      expect(result[0].data.a).toBe(2);
    });

    it("should subscribe and claim streams", async () => {
      const s = store();
      const { subscribed } = await s.subscribe([{ stream: "L1" }]);
      expect(subscribed).toBe(1);
      // Subscribe again — already exists
      const { subscribed: subscribed2 } = await s.subscribe([{ stream: "L1" }]);
      expect(subscribed2).toBe(0);
      // Claim should return the subscribed stream
      const claimed = await s.claim(1, 0, "worker-1", 10000);
      expect(claimed.length).toBe(1);
      expect(claimed[0].stream).toBe("L1");
      // Ack the claim
      await s.ack([claimed[0]]);
    });

    it("should claim with dual frontiers", async () => {
      const s = store();
      await s.subscribe([{ stream: "F1" }, { stream: "F2" }]);
      // Commit events so streams have work
      await s.commit("F1", [{ name: "A", data: {} }], {
        correlation: "c",
        causation: {},
      });
      await s.commit("F2", [{ name: "A", data: {} }], {
        correlation: "c",
        causation: {},
      });
      // Claim and ack F2 with higher watermark
      const claimed = await s.claim(2, 0, "actor", 1);
      expect(claimed.length).toBe(2);
      await s.ack(
        claimed.map((l) => ({ ...l, at: l.stream === "F2" ? 1 : 0 }))
      );
      // Add more events so streams have pending work
      await s.commit("F1", [{ name: "A", data: {} }], {
        correlation: "c",
        causation: {},
      });
      await s.commit("F2", [{ name: "A", data: {} }], {
        correlation: "c",
        causation: {},
      });
      // Both frontiers should find streams with pending events
      const result = await s.claim(2, 2, "actor", 1);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should claim with no streams", async () => {
      const { InMemoryStore } =
        await import("../src/adapters/InMemoryStore.js");
      const s = new InMemoryStore();
      const result = await s.claim(1, 1, "actor", 1);
      expect(result).toEqual([]);
    });

    it("should not claim blocked streams", async () => {
      const s = store();
      await s.subscribe([{ stream: "L2" }]);
      const claimed = await s.claim(1, 0, "actor", 10000);
      expect(claimed.length).toBe(1);
      await s.block([{ ...claimed[0], error: "test" }]);
      // Blocked stream should not appear
      const claimed2 = await s.claim(10, 10, "actor2", 10000);
      expect(claimed2.find((l) => l.stream === "L2")).toBeUndefined();
    });

    it("should ack with lower at without error", async () => {
      const s = store();
      await s.subscribe([{ stream: "L3" }]);
      const claimed = await s.claim(1, 0, "actor", 10000);
      // Ack with lower at — should not throw
      await s.ack([{ ...claimed[0], at: 1 }]);
    });

    it("should throw ConcurrencyError on commit with wrong expectedVersion", async () => {
      const s = store();
      await s.commit("S3", [{ name: "A", data: {} }], {
        correlation: "c",
        causation: {},
      });
      await s.commit(
        "S3",
        [{ name: "A", data: {} }],
        { correlation: "c", causation: {} },
        0
      );
      await expect(
        s.commit(
          "S3",
          [{ name: "A", data: {} }],
          { correlation: "c", causation: {} },
          0
        )
      ).rejects.toThrow(ConcurrencyError);
    });

    it("should not block a stream if not leased by same drainer", async () => {
      const s = store();
      await s.subscribe([{ stream: "L4" }]);
      const claimed = await s.claim(1, 0, "actor", 100000);
      expect(claimed.length).toBe(1);

      // Try to block with different drainer
      const blocked = await s.block([
        { ...claimed[0], by: "actor2", error: "error" },
      ]);
      expect(blocked.length).toBe(0);
    });

    it("should not claim already-leased streams", async () => {
      const s = store();
      await s.subscribe([{ stream: "L5" }]);
      // Claim with long lease
      const claimed = await s.claim(1, 0, "worker-1", 100000);
      expect(claimed.length).toBe(1);
      // Second claim should skip the leased stream
      const claimed2 = await s.claim(1, 0, "worker-2", 100000);
      expect(claimed2.find((l) => l.stream === "L5")).toBeUndefined();
    });

    it("should query_streams with filters and pagination", async () => {
      const s = store();
      // Mix of static targets (no source) and dynamic targets (with source)
      await s.subscribe([
        { stream: "projection-tickets" },
        { stream: "projection-users" },
        { stream: "stats-user-1", source: "user-1" },
        { stream: "stats-user-2", source: "user-2" },
        { stream: "stats-user-3", source: "user-3" },
      ]);
      // Commit some events so maxEventId > -1
      await s.commit(
        "user-1",
        [
          { name: "A", data: {} },
          { name: "B", data: {} },
        ],
        { correlation: "c", causation: {} }
      );

      // No filter — returns all, ordered by stream name
      const all: any[] = [];
      const allResult = await s.query_streams((p) => all.push(p));
      expect(allResult.count).toBe(5);
      expect(allResult.maxEventId).toBe(1);
      expect(all.map((p) => p.stream)).toEqual([
        "projection-tickets",
        "projection-users",
        "stats-user-1",
        "stats-user-2",
        "stats-user-3",
      ]);

      // stream regex filter
      const projections: any[] = [];
      await s.query_streams((p) => projections.push(p), {
        stream: "projection-.*",
      });
      expect(projections).toHaveLength(2);
      expect(projections.every((p) => p.stream.startsWith("projection-"))).toBe(
        true
      );

      // stream_exact
      const exact: any[] = [];
      await s.query_streams((p) => exact.push(p), {
        stream: "stats-user-1",
        stream_exact: true,
      });
      expect(exact).toHaveLength(1);
      expect(exact[0].source).toBe("user-1");

      // source filter — only rows with a source match
      const dynamics: any[] = [];
      await s.query_streams((p) => dynamics.push(p), { source: "user-.*" });
      expect(dynamics).toHaveLength(3);
      expect(dynamics.every((p) => p.source !== undefined)).toBe(true);

      // source_exact filter
      const exactSource: any[] = [];
      await s.query_streams((p) => exactSource.push(p), {
        source: "user-2",
        source_exact: true,
      });
      expect(exactSource).toHaveLength(1);
      expect(exactSource[0].stream).toBe("stats-user-2");

      // source_exact with no match drops the row
      const noMatch: any[] = [];
      await s.query_streams((p) => noMatch.push(p), {
        source: "user-99",
        source_exact: true,
      });
      expect(noMatch).toHaveLength(0);

      // limit + after (keyset pagination)
      const page1: any[] = [];
      await s.query_streams((p) => page1.push(p), { limit: 2 });
      expect(page1.map((p) => p.stream)).toEqual([
        "projection-tickets",
        "projection-users",
      ]);
      const page2: any[] = [];
      await s.query_streams((p) => page2.push(p), {
        limit: 2,
        after: page1.at(-1)!.stream,
      });
      expect(page2.map((p) => p.stream)).toEqual([
        "stats-user-1",
        "stats-user-2",
      ]);

      // blocked filter
      const claimed = await s.claim(1, 0, "w", 100000);
      await s.block([{ ...claimed[0], error: "boom" }]);
      const blocked: any[] = [];
      await s.query_streams((p) => blocked.push(p), { blocked: true });
      expect(blocked).toHaveLength(1);
      expect(blocked[0].error).toBe("boom");
      const unblocked: any[] = [];
      await s.query_streams((p) => unblocked.push(p), { blocked: false });
      expect(unblocked).toHaveLength(4);
    });

    it("should not ack with wrong lease holder", async () => {
      const s = store();
      await s.subscribe([{ stream: "L6" }]);
      const claimed = await s.claim(1, 0, "worker-1", 100000);
      expect(claimed.length).toBe(1);
      // Ack with wrong holder — should be silently ignored
      const acked = await s.ack([{ ...claimed[0], by: "wrong-worker" }]);
      expect(acked.length).toBe(0);
    });
  });
});
