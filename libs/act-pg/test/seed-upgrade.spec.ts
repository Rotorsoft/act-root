/**
 * The seed-sync contract: `seed()` IS the schema maintenance story —
 * additive, idempotent, lossless on any prior released shape, and safe
 * to run on every boot from every worker. Act deliberately has no
 * migration framework; this suite pins the guarantee the per-feature
 * specs (lanes, priority, retry-default) cover piecemeal, against one
 * canonical oldest-supported fixture.
 */

import { dispose, store } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_seed_upgrade_test";
const TABLE = "events";

const pool = () => (store() as unknown as { _pool: any })._pool;

/** Hand-build the oldest supported schema shape with legacy rows. */
async function build_oldest_shape() {
  const p = pool();
  await p.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await p.query(`CREATE SCHEMA "${SCHEMA}"`);
  // Events without the pii column.
  await p.query(`
    CREATE TABLE "${SCHEMA}"."${TABLE}" (
      id serial PRIMARY KEY,
      name varchar(100) NOT NULL,
      data jsonb,
      stream varchar(100) NOT NULL,
      version int NOT NULL,
      created timestamptz NOT NULL DEFAULT now(),
      meta jsonb
    )`);
  await p.query(
    `CREATE UNIQUE INDEX "${TABLE}_stream_ix" ON "${SCHEMA}"."${TABLE}" (stream, version)`
  );
  // Streams without priority / lane / deferred_at, with the superseded
  // fetch index the claim index later replaced.
  await p.query(`
    CREATE TABLE "${SCHEMA}"."${TABLE}_streams" (
      stream varchar(100) PRIMARY KEY,
      source varchar(100),
      at int NOT NULL DEFAULT -1,
      retry smallint NOT NULL DEFAULT -1,
      blocked boolean NOT NULL DEFAULT false,
      error text,
      leased_by text,
      leased_until timestamptz
    )`);
  await p.query(
    `CREATE INDEX "${TABLE}_streams_fetch_ix" ON "${SCHEMA}"."${TABLE}_streams" (blocked, at)`
  );
  // Legacy rows that must survive the upgrade untouched.
  await p.query(`
    INSERT INTO "${SCHEMA}"."${TABLE}" (name, data, stream, version, meta) VALUES
      ('opened', '{"n":1}', 'legacy-1', 0, '{"correlation":"c1","causation":{}}'),
      ('closed', '{"n":2}', 'legacy-1', 1, '{"correlation":"c2","causation":{}}')`);
  await p.query(
    `INSERT INTO "${SCHEMA}"."${TABLE}_streams" (stream, at) VALUES ('legacy-sub', 0)`
  );
}

const columns = async (table: string): Promise<string[]> => {
  const { rows } = await pool().query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [SCHEMA, table]
  );
  return rows.map((r: { column_name: string }) => r.column_name);
};

const indexes = async (table: string): Promise<string[]> => {
  const { rows } = await pool().query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
    [SCHEMA, table]
  );
  return rows.map((r: { indexname: string }) => r.indexname);
};

describe("PostgresStore seed-sync contract", () => {
  beforeEach(() => {
    store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
  });

  afterEach(async () => {
    await store().drop();
    await dispose()("EXIT").catch(() => {});
  });

  it("upgrades the oldest supported shape losslessly and idempotently", async () => {
    await build_oldest_shape();

    await store().seed();

    // Additive columns landed on both tables.
    expect(await columns(TABLE)).toContain("pii");
    const stream_cols = await columns(`${TABLE}_streams`);
    for (const c of ["priority", "lane", "deferred_at"])
      expect(stream_cols).toContain(c);

    // The superseded fetch index is gone; its replacement is present.
    const ix = await indexes(`${TABLE}_streams`);
    expect(ix).not.toContain(`${TABLE}_streams_fetch_ix`);
    expect(ix).toContain(`${TABLE}_streams_claim_ix`);

    // Legacy rows are intact, with migration defaults applied.
    const { rows: events } = await pool().query(
      `SELECT name, data, version, pii FROM "${SCHEMA}"."${TABLE}" ORDER BY version`
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ name: "opened", version: 0, pii: null });
    expect(events[1].data).toEqual({ n: 2 });
    const seen: any[] = [];
    await store().query_streams((s) => seen.push(s), {
      stream: "legacy-sub",
      stream_exact: true,
    });
    expect(seen[0]).toMatchObject({ at: 0, priority: 0, lane: "default" });

    // A second seed is a no-op: same columns, same rows.
    await store().seed();
    expect((await columns(`${TABLE}_streams`)).sort()).toEqual(
      stream_cols.sort()
    );
    const { rows: again } = await pool().query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."${TABLE}"`
    );
    expect(again[0].n).toBe(2);
  });

  it("serializes concurrent cold boots on an empty schema", async () => {
    await pool().query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    // N workers booting at once: the transaction-scoped advisory lock
    // serializes the IF NOT EXISTS DDL, so every call resolves and one
    // usable schema results.
    await Promise.all([
      store().seed(),
      store().seed(),
      store().seed(),
      store().seed(),
    ]);
    const { rows } = await pool().query(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [SCHEMA, TABLE]
    );
    expect(rows[0].n).toBe(1);
    // The store is immediately usable after the concurrent boot.
    await store().commit("boot-1", [{ name: "opened", data: { n: 1 } }], {
      correlation: "c1",
      causation: { action: { name: "open", stream: "boot-1" } },
    } as never);
  });
});
