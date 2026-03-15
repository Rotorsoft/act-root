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
      // Claim and ack with different watermarks
      const claimed = await s.claim(2, 0, "actor", 1);
      await s.ack(claimed.map((l, i) => ({ ...l, at: i + 1 })));
      // Both frontiers should find streams
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
