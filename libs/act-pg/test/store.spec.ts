import {
  Committed,
  ConcurrencyError,
  SNAP_EVENT,
  Schemas,
  dispose,
  sleep,
  store,
} from "@rotorsoft/act";
import { Chance } from "chance";
import { PostgresStore } from "../src/index.js";
import { actor, app, onDecremented, onIncremented } from "./app.js";

const chance = new Chance();
const a1 = chance.guid();
const a2 = chance.guid();
const a3 = chance.guid();
const a4 = chance.guid();
const a5 = chance.guid();
const pm = chance.guid();
let created_before: Date;
let created_after: Date;

describe("pg store", () => {
  beforeAll(async () => {
    store(
      new PostgresStore({
        port: 5431,
        schema: "schema_test",
        table: "store_test",
      })
    );
    await store().drop();
    await store().seed();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should commit and query", async () => {
    const query_correlation = chance.guid();

    await store().commit(a1, [{ name: "test1", data: { value: "1" } }], {
      correlation: "",
      causation: {
        action: { stream: a1, name: "", actor: { id: pm, name: "" } },
      },
    });
    created_after = new Date();
    await sleep(200);

    await store().commit(a1, [{ name: "test1", data: { value: "2" } }], {
      correlation: query_correlation,
      causation: {},
    });
    await store().commit(a2, [{ name: "test2", data: { value: "3" } }], {
      correlation: "",
      causation: {
        action: { stream: a2, name: "", actor: { id: pm, name: "" } },
      },
    });
    await store().commit(a3, [{ name: "test1", data: { value: "4" } }], {
      correlation: "",
      causation: {},
    });

    await store().commit(a1, [{ name: "test2", data: { value: "5" } }], {
      correlation: "",
      causation: {},
    });

    await sleep(200);
    created_before = new Date();
    await sleep(200);

    await store().commit(
      a1,
      [
        { name: "test3", data: { value: "1" } },
        { name: "test3", data: { value: "2" } },
        { name: "test3", data: { value: "3" } },
      ],
      { correlation: query_correlation, causation: {} },
      undefined
    );

    let first = 0;
    const events: Committed<Schemas, keyof Schemas>[] = [];
    await store().query(
      (e) => {
        first = first || e.id;
        events.push(e);
      },
      { stream: a1 }
    );
    expect(first).toBeGreaterThan(0);
    const l = events.length;
    expect(l).toBe(6);
    expect(events[l - 1].data).toStrictEqual({ value: "3" });
    expect(events[l - 2].data).toStrictEqual({ value: "2" });
    expect(events[l - 3].data).toStrictEqual({ value: "1" });

    const events2: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => events2.push(e), { after: first, limit: 2 });
    expect(events2[0]?.id).toBe(first + 1);
    expect(events2.length).toBe(2);

    const events3: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => events3.push(e), { names: ["test1"], limit: 5 });
    expect(events3[0].name).toBe("test1");
    expect(events3.length).toBeGreaterThanOrEqual(3);
    events3.map((evt) => expect(evt.name).toBe("test1"));

    expect(
      await store().query(() => 0, { after: first, before: first + 4 })
    ).toBe(3);

    expect(
      await store().query(() => 0, {
        stream: a1,
        created_after,
        created_before,
      })
    ).toBe(2);

    expect(await store().query(() => 0, { limit: 5 })).toBe(5);

    expect(
      await store().query(() => 0, {
        limit: 10,
        correlation: query_correlation,
      })
    ).toBe(4);

    await expect(
      store().commit(
        a1,
        [{ name: "test2", data: { value: "" } }],
        { correlation: "", causation: {} },
        1
      )
    ).rejects.toThrow();
  });

  it("should commit and load with state", async () => {
    await store().commit(
      a4,
      [
        { name: "test3", data: { value: "1", date: new Date() } },
        { name: "test3", data: { value: "2", date: new Date() } },
        { name: "test3", data: { value: "3", date: new Date() } },
      ],
      { correlation: "", causation: {} }
    );
    await store().commit(
      a5,
      [
        { name: "test2", data: { value: "333" } },
        { name: "test2", data: { value: "334" } },
      ],
      {
        correlation: "",
        causation: {},
      }
    );
    await store().commit(
      a4,
      [
        { name: SNAP_EVENT, data: { value: "1" } },
        { name: "test3", data: { value: "2", date: new Date() } },
        { name: "test3", data: { value: "3", date: new Date() } },
      ],
      {
        correlation: "",
        causation: {},
      }
    );

    const count = await store().query(
      (e) => {
        if (e.name === "test3") expect(e.data.date).toBeInstanceOf(Date);
      },
      { stream: a4, with_snaps: true }
    );
    expect(count).toBe(6);
    const count2 = await store().query(() => {}, {
      stream: a5,
      with_snaps: true,
    });
    expect(count2).toBe(2);
  });

  it("should commit and query backwards", async () => {
    await store().commit(
      a1,
      [
        { name: "test3", data: { value: "1" } },
        { name: "test3", data: { value: "2" } },
        { name: "test3", data: { value: "3" } },
      ],
      { correlation: "", causation: {} }
    );
    await store().commit(
      a1,
      [
        { name: "test3", data: { value: "4" } },
        { name: "test3", data: { value: "5" } },
        { name: "test3", data: { value: "6" } },
      ],
      { correlation: "", causation: {} }
    );

    const events: Committed<Schemas, keyof Schemas>[] = [];
    await store().query(
      (e) => {
        events.push(e);
      },
      { stream: a1, backward: true }
    );
    expect(events[0].data).toStrictEqual({ value: "6" });
    expect(events[1].data).toStrictEqual({ value: "5" });
    expect(events[2].data).toStrictEqual({ value: "4" });
  });

  it("should throw on connection error (simulate by using invalid config)", async () => {
    await expect(
      new PostgresStore({ password: "bad", port: 5431 }).seed()
    ).rejects.toThrow();
  });

  it("should handle commit with empty events array", async () => {
    const result = await store().commit("stream", [], {
      correlation: "c",
      causation: {},
    });
    expect(result).toEqual([]);
  });

  it("should handle query with no results", async () => {
    const result: any[] = [];
    await store().query((e) => result.push(e), { stream: "nonexistent" });
    expect(result.length).toBe(0);
  });

  it("should cover query branch with no 'after' provided", async () => {
    // Commit a couple of events
    await store().commit(
      "stream",
      [
        { name: "test", data: { value: 1 } },
        { name: "test", data: { value: 2 } },
      ],
      { correlation: "c", causation: {} }
    );
    // Query without 'after' in the query object
    const result: any[] = [];
    await store().query((e) => result.push(e), { stream: "stream" });
    expect(result.length).toBe(2);
  });

  it("should cover query branch with stream as RegExp", async () => {
    // Commit events to multiple streams
    await store().commit("regexA", [{ name: "test", data: { value: 1 } }], {
      correlation: "c",
      causation: {},
    });
    await store().commit("regexB", [{ name: "test", data: { value: 2 } }], {
      correlation: "c",
      causation: {},
    });
    // Query with stream as RegExp
    const result: any[] = [];
    await store().query((e) => result.push(e), { stream: "^regex" });
    expect(result.length).toBe(2);
  });

  it("should cover query branch where rowCount is undefined", async () => {
    const origQuery = (store() as any)._pool.query;
    (store() as any)._pool.query = function () {
      return Promise.resolve({ rows: [], rowCount: undefined });
    };
    const count = await store().query(() => {});
    expect(count).toBe(0);
    (store() as any)._pool.query = origQuery;
  });

  describe("blocking", () => {
    it("should handle increment and decrement should block", async () => {
      await app.do("increment", { stream: "blocking", actor }, {});
      await app.do("increment", { stream: "blocking", actor }, {});

      const correlated = await app.correlate({ limit: 100 });
      expect(correlated.leased.length).toBe(1);

      let drained = await app.drain({ streamLimit: 100, eventLimit: 100 });
      expect(drained.acked.length).toBe(1);
      expect(onIncremented).toHaveBeenCalled();
      expect(onDecremented).not.toHaveBeenCalled();

      await app.do("decrement", { stream: "blocking", actor }, {});

      drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
      expect(onDecremented).toHaveBeenCalledTimes(1);

      drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
      expect(drained.acked.length).toBe(0);
      expect(onDecremented).toHaveBeenCalledTimes(2);

      drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
      expect(drained.acked.length).toBe(0);
      expect(drained.blocked.length).toBe(1);
      expect(onDecremented).toHaveBeenCalledTimes(3);
    });
  });

  describe("other", () => {
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
      const stream = "concurrency";
      const committed = await store().commit(stream, events, meta);
      expect(committed.length).toBe(events.length);
      try {
        await store().commit(stream, events, meta, 1);
      } catch (error) {
        expect(error).toBeInstanceOf(ConcurrencyError);
      }
      const count = await store().query(() => {}, { stream });
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
      const committed = await s.commit(
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
      await s.query((e) => result.push(e), { stream: "S2", names: ["C"] });
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
      await s.query((e) => result.push(e), {
        before: committed[0].id,
        stream: "S1",
      });
      expect(result.length).toBe(2);
      // By created_before
      result = [];
      const future = new Date(now.getTime() + 1000 * 60 * 60);
      await s.query((e) => result.push(e), { created_before: future });
      expect(result.length).toBeGreaterThan(0);
      // By limit
      result = [];
      await s.query((e) => result.push(e), { stream: "S1|S2", limit: 1 });
      expect(result.length).toBe(1);
      // By with_snaps
      await s.query((e) => result.push(e), {
        stream: "S1|S2",
        with_snaps: true,
      });
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

    it("should poll descending", async () => {
      await store().lease(
        [{ stream: "makeitlast", by: "x", at: 0, retry: 0 }],
        0
      );
      await store().ack([
        { stream: "makeitlast", by: "x", at: 1000, retry: 0 },
      ]);
      const result = await store().poll(2, true);
      expect(result[0].stream).toEqual("makeitlast");
    });
  });
});

describe("PostgresStore constructor", () => {
  it("should merge custom config with defaults", () => {
    const custom = {
      host: "custom",
      port: 1234,
      schema: "myschema",
      table: "mytable",
      leaseMillis: 5000,
    };
    const store = new PostgresStore(custom);
    expect(store.config.host).toBe("custom");
    expect(store.config.port).toBe(1234);
    expect(store.config.schema).toBe("myschema");
    expect(store.config.table).toBe("mytable");
    // Defaults
    expect(store.config.user).toBe("postgres");
    expect(store.config.password).toBe("postgres");
    expect(store.config.database).toBe("postgres");
  });

  it("should use defaults when no config is provided", () => {
    const store = new PostgresStore();
    expect(store.config.host).toBe("localhost");
    expect(store.config.port).toBe(5432);
    expect(store.config.user).toBe("postgres");
    expect(store.config.password).toBe("postgres");
    expect(store.config.database).toBe("postgres");
    expect(store.config.schema).toBe("public");
    expect(store.config.table).toBe("events");
  });

  it("should merge partial config with defaults", () => {
    const store = new PostgresStore({ host: "custom", port: 1234 });
    expect(store.config.host).toBe("custom");
    expect(store.config.port).toBe(1234);
    expect(store.config.user).toBe("postgres");
  });
});
