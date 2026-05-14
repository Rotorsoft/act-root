import { dispose, SNAP_EVENT, store } from "@rotorsoft/act";
import { Chance } from "chance";
import { Pool } from "pg";
import { PostgresStore } from "../src/index.js";
import {
  actor,
  app,
  buildApp,
  onDecremented,
  onIncremented,
  setApp,
} from "./app.js";

const chance = new Chance();
const a4 = chance.guid();
const a5 = chance.guid();

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
    // Build the orchestrator AFTER injecting the store — the notify
    // wiring binds at construction, so late injection wouldn't take.
    setApp(buildApp());
  });

  afterAll(async () => {
    await dispose()();
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

  it("should cover query branch where rowCount is undefined", async () => {
    const origQuery = (store() as any)._pool.query;
    (store() as any)._pool.query = () =>
      Promise.resolve({ rows: [], rowCount: undefined });
    const count = await store().query(() => {});
    expect(count).toBe(0);
    (store() as any)._pool.query = origQuery;
  });

  describe("blocking", () => {
    it("should handle increment and decrement should block", async () => {
      await app.do("increment", { stream: "blocking", actor }, {});
      await app.do("increment", { stream: "blocking", actor }, {});

      const correlated = await app.correlate({ limit: 100 });
      expect(correlated.subscribed).toBe(1);

      let drained = await app.drain({ streamLimit: 100, eventLimit: 100 });
      expect(drained.acked.length).toBe(1);
      expect(onIncremented).toHaveBeenCalled();
      expect(onDecremented).not.toHaveBeenCalled();

      await app.do("decrement", { stream: "blocking", actor }, {});

      await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
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
});

describe("PostgresStore error paths", () => {
  let db: PostgresStore;

  beforeAll(() => {
    db = new PostgresStore({
      port: 5431,
      schema: "err_test",
      table: "err_test",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockClient = (failOn: string) => ({
    query: (sql: string) => {
      if (typeof sql === "string" && sql.includes(failOn))
        return Promise.reject(new Error(`mocked ${failOn} error`));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => {},
  });

  it("should reject unsafe schema names", () => {
    expect(() => new PostgresStore({ schema: "drop;--" })).toThrow(
      /Unsafe SQL identifier/
    );
  });

  it("should reject unsafe table names", () => {
    expect(() => new PostgresStore({ table: "x'; DROP TABLE" })).toThrow(
      /Unsafe SQL identifier/
    );
  });

  it("should handle seed() error", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockClient("CREATE") as any
    );
    await expect(db.seed()).rejects.toThrow("mocked CREATE error");
  });

  it("should handle commit() ROLLBACK path", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockClient("INSERT") as any
    );
    await expect(
      db.commit("s", [{ name: "A", data: {} }], {
        correlation: "",
        causation: {},
      })
    ).rejects.toThrow("mocked INSERT error");
  });

  it("should handle subscribe() error", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockClient("INSERT") as any
    );
    const result = await db.subscribe([{ stream: "x" }]);
    expect(result).toEqual({ subscribed: 0, watermark: -1 });
  });

  it("should handle reset() with null rowCount", async () => {
    vi.spyOn(Pool.prototype, "query").mockResolvedValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- testing null rowCount path
      { rows: [], rowCount: null } as any
    );
    const result = await db.reset(["x"]);
    expect(result).toBe(0);
  });

  it("should handle ack() error", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockClient("UPDATE") as any
    );
    const result = await db.ack([
      { stream: "x", at: 0, by: "w", retry: 0, lagging: false },
    ]);
    expect(result).toEqual([]);
  });

  it("should handle claim() error", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockClient("BEGIN") as any
    );
    const result = await db.claim(1, 0, "w", 1000);
    expect(result).toEqual([]);
  });

  it("should handle block() error", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockClient("UPDATE") as any
    );
    const result = await db.block([
      { stream: "x", at: 0, by: "w", retry: 0, lagging: false, error: "e" },
    ]);
    expect(result).toEqual([]);
  });

  it("should handle truncate() error", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockClient("DELETE") as any
    );
    await expect(db.truncate([{ stream: "x" }])).rejects.toThrow(
      "mocked DELETE error"
    );
  });

  it("should handle truncate() with null rowCount on delete", async () => {
    const mockTruncateClient = {
      query: (sql: string) => {
        if (typeof sql === "string" && sql.includes("INSERT"))
          return Promise.resolve({
            rows: [
              {
                id: 1,
                stream: "x",
                version: 0,
                name: "__tombstone__",
                data: {},
                meta: {},
                created: new Date(),
              },
            ],
            rowCount: 1,
          });
        // DELETE and other queries return null rowCount
        return Promise.resolve({ rows: [], rowCount: null });
      },
      release: () => {},
    };
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => mockTruncateClient as any
    );
    const result = await db.truncate([{ stream: "x" }]);
    expect(result.get("x")!.deleted).toBe(0);
  });

  it("should handle ROLLBACK failure gracefully", async () => {
    // Mock where every query fails — both the operation and the ROLLBACK
    const failAll = () => ({
      query: () => Promise.reject(new Error("connection dead")),
      release: () => {},
    });
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () => failAll() as any
    );
    const result = await db.ack([
      { stream: "x", at: 0, by: "w", retry: 0, lagging: false },
    ]);
    expect(result).toEqual([]);
    const result2 = await db.claim(1, 0, "w", 1000);
    expect(result2).toEqual([]);
    const result3 = await db.subscribe([{ stream: "x" }]);
    expect(result3).toEqual({ subscribed: 0, watermark: -1 });
    const result4 = await db.block([
      { stream: "x", at: 0, by: "w", retry: 0, lagging: false, error: "e" },
    ]);
    expect(result4).toEqual([]);
    await expect(
      db.commit("s", [{ name: "A", data: {} }], {
        correlation: "",
        causation: {},
      })
    ).rejects.toThrow();
    await expect(db.truncate([{ stream: "x" }])).rejects.toThrow();
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
