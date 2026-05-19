/**
 * ACT-1103 — `PostgresStore` drain lanes integration tests against
 * docker PG. Schema migration, subscribe UPSERT, claim() lane filter,
 * StreamFilter.lane wiring across query_streams / prioritize / reset /
 * unblock.
 */

import { randomUUID } from "node:crypto";
import { dispose, store } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_lane_test";
const TABLE = "events";

describe("PostgresStore drain lanes", () => {
  beforeEach(async () => {
    store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("subscribe defaults lane to 'default'", async () => {
    await store().subscribe([{ stream: "no-lane" }]);
    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), {
      stream: "no-lane",
      stream_exact: true,
    });
    expect(seen[0].lane).toBe("default");
  });

  it("subscribe records the lane passed in", async () => {
    await store().subscribe([{ stream: "slow-stream", lane: "slow" }]);
    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), {
      stream: "slow-stream",
      stream_exact: true,
    });
    expect(seen[0].lane).toBe("slow");
  });

  it("subscribe re-lanes existing streams (restart-driven config change)", async () => {
    await store().subscribe([{ stream: "x", lane: "slow" }]);
    await store().subscribe([{ stream: "x", lane: "fast" }]);
    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), {
      stream: "x",
      stream_exact: true,
    });
    expect(seen[0].lane).toBe("fast");
  });

  it("claim() filters by lane when supplied; returns lane in the Lease", async () => {
    const meta = { correlation: "", causation: {} };
    await store().commit("src-a", [{ name: "A", data: {} }], meta);
    await store().commit("src-b", [{ name: "B", data: {} }], meta);
    await store().subscribe([
      { stream: "sub-default", source: "src-a" },
      { stream: "sub-slow", source: "src-b", lane: "slow" },
    ]);

    const slow = await store().claim(10, 0, randomUUID(), 1_000, "slow");
    expect(slow.map((l) => l.stream)).toEqual(["sub-slow"]);
    expect(slow[0]?.lane).toBe("slow");

    await store().ack(slow.map((l) => ({ ...l, at: 0 })));
    const all = await store().claim(10, 0, randomUUID(), 1_000);
    const streams = all.map((l) => l.stream).sort();
    expect(streams).toEqual(["sub-default", "sub-slow"]);
    // Both leases carry their lane back from the store.
    expect(all.find((l) => l.stream === "sub-default")?.lane).toBe("default");
    expect(all.find((l) => l.stream === "sub-slow")?.lane).toBe("slow");
  });

  it("query_streams filters by lane", async () => {
    await store().subscribe([
      { stream: "a", lane: "slow" },
      { stream: "b", lane: "fast" },
      { stream: "c", lane: "slow" },
    ]);
    const seen: string[] = [];
    await store().query_streams((p) => seen.push(p.stream), { lane: "slow" });
    expect(seen.sort()).toEqual(["a", "c"]);
  });

  it("prioritize filters by lane", async () => {
    await store().subscribe([
      { stream: "a", lane: "slow" },
      { stream: "b", lane: "fast" },
    ]);
    const updated = await store().prioritize({ lane: "slow" }, 7);
    expect(updated).toBe(1);

    const positions = new Map<string, number>();
    await store().query_streams((p) => positions.set(p.stream, p.priority));
    expect(positions.get("a")).toBe(7);
    expect(positions.get("b")).toBe(0);
  });

  it("reset filters by lane", async () => {
    const meta = { correlation: "", causation: {} };
    await store().commit("src", [{ name: "X", data: {} }], meta);
    await store().subscribe([
      { stream: "a", source: "src", lane: "slow" },
      { stream: "b", source: "src", lane: "fast" },
    ]);
    // Advance watermarks so reset has work to do.
    const leases = await store().claim(2, 0, randomUUID(), 5_000);
    await store().ack(leases.map((l) => ({ ...l, at: 0 })));

    const count = await store().reset({ lane: "slow" });
    expect(count).toBe(1);

    const seen = new Map<string, number>();
    await store().query_streams((p) => seen.set(p.stream, p.at));
    expect(seen.get("a")).toBe(-1);
    expect(seen.get("b")).toBe(0);
  });

  it("unblock filters by lane", async () => {
    const meta = { correlation: "", causation: {} };
    await store().commit("src", [{ name: "X", data: {} }], meta);
    await store().subscribe([
      { stream: "a", source: "src", lane: "slow" },
      { stream: "b", source: "src", lane: "fast" },
    ]);
    const leases = await store().claim(2, 0, randomUUID(), 5_000);
    await store().block(leases.map((l) => ({ ...l, error: "boom" })));

    const count = await store().unblock({ lane: "slow" });
    expect(count).toBe(1);

    const blocked = new Map<string, boolean>();
    await store().query_streams((p) => blocked.set(p.stream, p.blocked));
    expect(blocked.get("a")).toBe(false);
    expect(blocked.get("b")).toBe(true);
  });

  it("seed migration is idempotent — adds lane on existing tables", async () => {
    // Drop + manually create a pre-1103 table without `lane`, then
    // call seed() and verify the column was added and defaults applied.
    const pool = (store() as any)._pool;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pool.query(`
      CREATE TABLE "${SCHEMA}"."${TABLE}_streams" (
        stream varchar(100) PRIMARY KEY,
        source varchar(100),
        at int NOT NULL DEFAULT -1,
        retry smallint NOT NULL DEFAULT 0,
        blocked boolean NOT NULL DEFAULT false,
        error text,
        leased_by text,
        leased_until timestamptz,
        priority int NOT NULL DEFAULT 0
      )`);
    await pool.query(`
      CREATE TABLE "${SCHEMA}"."${TABLE}" (
        id serial PRIMARY KEY,
        name varchar(100) NOT NULL,
        data jsonb,
        stream varchar(100) NOT NULL,
        version int NOT NULL,
        created timestamptz NOT NULL DEFAULT now(),
        meta jsonb
      )`);
    await pool.query(
      `CREATE UNIQUE INDEX ON "${SCHEMA}"."${TABLE}" (stream, version)`
    );

    // Pre-existing row without lane — uses migration default.
    await pool.query(
      `INSERT INTO "${SCHEMA}"."${TABLE}_streams" (stream) VALUES ('legacy')`
    );

    await store().seed();

    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), {
      stream: "legacy",
      stream_exact: true,
    });
    expect(seen[0].lane).toBe("default");
  });
});
