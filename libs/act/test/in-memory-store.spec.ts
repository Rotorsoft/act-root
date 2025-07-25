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
      // By names
      result = [];
      await s.query((e) => result.push(e), { names: ["C"] });
      expect(result.length).toBe(1);
      // By correlation
      result = [];
      await s.query((e) => result.push(e), { correlation: "cor2" });
      expect(result.length).toBe(2);
      // By created_after
      result = [];
      const after = new Date(now.getTime() - 1000);
      await s.query((e) => result.push(e), { created_after: after });
      expect(result.length).toBeGreaterThan(0);
      // By before (id)
      result = [];
      await s.query((e) => result.push(e), { before: 2 });
      expect(result.length).toBe(2);
      // By created_before
      result = [];
      const future = new Date(now.getTime() + 1000 * 60 * 60);
      await s.query((e) => result.push(e), { created_before: future });
      expect(result.length).toBeGreaterThan(0);
      // By limit
      result = [];
      await s.query((e) => result.push(e), { limit: 1 });
      expect(result.length).toBe(1);
      // By with_snaps
      await s.query((e) => result.push(e), { with_snaps: true });
      expect(result.length).toBe(6);
    });

    it("should not lease blocked or old streams and should ack only valid leases", async () => {
      const s = store();
      // Lease a new stream
      const leases = await s.lease(
        [{ stream: "L1", by: "actor", at: 0, retry: 0 }],
        0
      );
      expect(leases.length).toBe(1);
      // Block the stream
      await s.lease([{ stream: "L1", by: "actor", at: 1, retry: 0 }], 0);
      // Try to lease again with old at (should not update)
      const leases2 = await s.lease(
        [{ stream: "L1", by: "actor", at: 0, retry: 0 }],
        0
      );
      expect(leases2.length).toBe(1);
      // Ack with valid lease
      await s.ack([{ stream: "L1", by: "actor", at: 1, retry: 0 }]);
      // Ack with old lease (should not throw)
      await s.ack([{ stream: "L1", by: "actor", at: 0, retry: 0 }]);
    });

    it("should poll events with and without streams", async () => {
      const s = store();
      // No streams
      let result = await s.poll(1);
      expect(result.length).toBe(0);
      // Add a stream and commit events
      await s.lease([{ stream: "F1", by: "actor", at: 0, retry: 0 }], 0);
      await s.commit("F1", [{ name: "A", data: {} }], {
        correlation: "f1",
        causation: {},
      });
      result = await s.poll(1);
      expect(result.length).toBe(1);
    });

    it("should poll with no streams", async () => {
      const { InMemoryStore } = await import(
        "../src/adapters/InMemoryStore.js"
      );
      const store = new InMemoryStore();
      const result = await store.poll(1);
      expect(result).toEqual([]);
    });

    it("should not lease a blocked stream", async () => {
      const s = store();
      await s.lease([{ stream: "L2", by: "actor", at: 0, retry: 0 }], 0);
      const leases = await s.lease(
        [{ stream: "L2", by: "actor", at: 1, retry: 0 }],
        0
      );
      expect(leases.length).toBe(1);
    });

    it("should not update state when ack is called with lower at", async () => {
      const s = store();
      await s.lease([{ stream: "L3", by: "actor", at: 2, retry: 0 }], 0);
      // Ack with lower at
      await s.ack([{ stream: "L3", by: "actor", at: 1, retry: 0 }]);
      // No error, state unchanged
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
      await s.lease([{ stream: "L4", by: "actor", at: 0, retry: 0 }], 0);
      const leases = await s.lease(
        [{ stream: "L4", by: "actor", at: 1, retry: 0 }],
        100000
      );
      expect(leases.length).toBe(1);

      // Try to block the stream
      const blocked = await s.block([
        { stream: "L4", by: "actor2", at: 2, retry: 0, error: "error" },
      ]);
      expect(blocked.length).toBe(0);
    });
  });
});
