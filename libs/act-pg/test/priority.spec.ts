/**
 * ACT-102 — `PostgresStore` priority lanes integration tests against
 * docker PG. Subscribe `max()` semantics, `claim()` ordering,
 * `prioritize()` filter shapes (regex, exact, blocked).
 */

import { randomUUID } from "node:crypto";
import { dispose, store } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_priority_test";
const TABLE = "events";

describe("PostgresStore priority lanes", () => {
  beforeEach(async () => {
    store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("subscribe keeps the max priority across reactions", async () => {
    await store().subscribe([{ stream: "shared", priority: 3 }]);
    await store().subscribe([{ stream: "shared", priority: 1 }]); // ignored
    await store().subscribe([{ stream: "shared", priority: 9 }]); // wins

    const positions: any[] = [];
    await store().query_streams((p) => positions.push(p), { stream: "shared" });
    expect(positions[0].priority).toBe(9);
  });

  it("claim returns higher-priority streams first under tied watermarks", async () => {
    const meta = { correlation: "", causation: {} };
    await store().commit("src", [{ name: "X", data: {} }], meta);
    await store().commit("src", [{ name: "Y", data: {} }], meta);

    await store().subscribe([
      { stream: "low", source: "src", priority: 0 },
      { stream: "high", source: "src", priority: 5 },
    ]);

    const leases = await store().claim(1, 0, randomUUID(), 5_000);
    expect(leases.map((l) => l.stream)).toEqual(["high"]);
  });

  it("prioritize updates by exact stream match", async () => {
    await store().subscribe([{ stream: "a" }, { stream: "b" }]);
    const updated = await store().prioritize(
      { stream: "b", stream_exact: true },
      7
    );
    expect(updated).toBe(1);

    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p));
    const byStream = Object.fromEntries(
      seen.map((p) => [p.stream, p.priority])
    );
    expect(byStream).toEqual({ a: 0, b: 7 });
  });

  it("prioritize matches by regex", async () => {
    await store().subscribe([
      { stream: "proj-a" },
      { stream: "proj-b" },
      { stream: "audit-x" },
    ]);
    // PG `~` is unanchored regex — `^proj-` matches both proj rows.
    const updated = await store().prioritize({ stream: "^proj-" }, 3);
    expect(updated).toBe(2);
  });

  it("prioritize matches by source filter", async () => {
    await store().subscribe([
      { stream: "t1", source: "users" },
      { stream: "t2", source: "audit" },
    ]);
    const updated = await store().prioritize(
      { source: "users", source_exact: true },
      4
    );
    expect(updated).toBe(1);
  });

  it("prioritize source filter ignores rows without source", async () => {
    await store().subscribe([
      { stream: "no-source" },
      { stream: "with-source", source: "x" },
    ]);
    const updated = await store().prioritize({ source: "x" }, 2);
    expect(updated).toBe(1);
  });

  it("prioritize with empty filter updates every registered stream", async () => {
    await store().subscribe([{ stream: "a" }, { stream: "b" }]);
    const updated = await store().prioritize({}, 5);
    expect(updated).toBe(2);
  });

  it("prioritize is a no-op when value matches existing", async () => {
    await store().subscribe([{ stream: "a", priority: 5 }]);
    const updated = await store().prioritize({}, 5);
    expect(updated).toBe(0);
  });

  it("prioritize matches by blocked state", async () => {
    const meta = { correlation: "", causation: {} };
    await store().commit("src", [{ name: "X", data: {} }], meta);
    await store().subscribe([
      { stream: "ok", source: "src" },
      { stream: "bad", source: "src" },
    ]);
    const leases = await store().claim(2, 0, randomUUID(), 5_000);
    const badLease = leases.find((l) => l.stream === "bad")!;
    await store().block([{ ...badLease, error: "boom" }]);

    const updated = await store().prioritize({ blocked: true }, 9);
    expect(updated).toBe(1);
  });

  it("query_streams emits priority in StreamPosition", async () => {
    await store().subscribe([{ stream: "x", priority: 4 }]);
    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), { stream: "x" });
    expect(seen[0].priority).toBe(4);
  });

  it("seed migration is idempotent — adding priority on existing tables", async () => {
    // Drop + manually create an old-shape table without `priority`,
    // then call seed() and verify the column was added.
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
        leased_until timestamptz
      )`);
    // events table needed for the SELECT MAX(id) in subsequent calls.
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

    // Pre-existing row without priority — uses table default.
    await pool.query(
      `INSERT INTO "${SCHEMA}"."${TABLE}_streams" (stream) VALUES ('legacy')`
    );

    await store().seed(); // idempotent re-seed should add priority col.

    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), { stream: "legacy" });
    expect(seen[0].priority).toBe(0);
  });
});
