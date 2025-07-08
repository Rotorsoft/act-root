import {
  Committed,
  SNAP_EVENT,
  Schemas,
  dispose,
  sleep,
  store,
} from "@rotorsoft/act";
import { Chance } from "chance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";

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
      { stream: a4 },
      true
    );
    expect(count).toBe(3);
    const count2 = await store().query(() => {}, { stream: a5 }, true);
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
    const { PostgresStore } = await import("../src/PostgresStore.js");
    await expect(
      new PostgresStore({ password: "bad", port: 5431 }).seed()
    ).rejects.toThrow();
  });

  it("should handle commit with empty events array", async () => {
    const { PostgresStore } = await import("../src/PostgresStore.js");
    const store = new PostgresStore({ port: 5431 });
    await store.seed();
    const result = await store.commit("stream", [], {
      correlation: "c",
      causation: {},
    });
    expect(result).toEqual([]);
  });

  it("should handle query with no results", async () => {
    const { PostgresStore } = await import("../src/PostgresStore.js");
    const store = new PostgresStore({ port: 5431 });
    await store.seed();
    const result: any[] = [];
    await store.query((e) => result.push(e), { stream: "nonexistent" });
    expect(result.length).toBe(0);
  });
});

describe("PostgresStore config", () => {
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
    expect(store.config.leaseMillis).toBe(5000);
    // Defaults
    expect(store.config.user).toBe("postgres");
    expect(store.config.password).toBe("postgres");
    expect(store.config.database).toBe("postgres");
  });
});

describe("PostgresStore constructor", () => {
  it("should use defaults when no config is provided", () => {
    const store = new PostgresStore();
    expect(store.config.host).toBe("localhost");
    expect(store.config.port).toBe(5432);
    expect(store.config.user).toBe("postgres");
    expect(store.config.password).toBe("postgres");
    expect(store.config.database).toBe("postgres");
    expect(store.config.schema).toBe("public");
    expect(store.config.table).toBe("events");
    expect(store.config.leaseMillis).toBe(30000);
  });
  it("should merge partial config with defaults", () => {
    const store = new PostgresStore({ host: "custom", port: 1234 });
    expect(store.config.host).toBe("custom");
    expect(store.config.port).toBe(1234);
    expect(store.config.user).toBe("postgres");
  });
});
