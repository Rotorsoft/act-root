/**
 * The seed-sync contract: `seed()` IS the schema maintenance story —
 * additive, idempotent, lossless on any prior released shape, and safe
 * to run on every boot from every worker. Act deliberately has no
 * migration framework; this suite pins the guarantee against one
 * canonical oldest-supported fixture, including the `priority`, `lane` and
 * `deferred_at` columns added since.
 */

import { dispose, store } from "@rotorsoft/act";
import { Client, Pool } from "pg";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const PORT = 5431;
const SCHEMA = schema("act_seed_upgrade_test");
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

const column_type = async (
  table: string,
  column: string
): Promise<string | undefined> => {
  const { rows } = await pool().query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [SCHEMA, table, column]
  );
  return rows[0]?.data_type as string | undefined;
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

    // The legacy `smallint` retry column is widened to `int` so a
    // poison stream's ever-climbing retry counter never overflows.
    expect(await column_type(`${TABLE}_streams`, "retry")).toBe("integer");

    // The legacy `varchar(100)` identifier columns are widened to
    // `text`. The framework DERIVES identifiers from stream names — an
    // `.autocloses` target is `"__autoclose__:" + stream` — so the cap broke
    // framework-generated names, not just user input.
    expect(await column_type(TABLE, "stream")).toBe("text");
    expect(await column_type(TABLE, "name")).toBe("text");
    expect(await column_type(`${TABLE}_streams`, "stream")).toBe("text");
    expect(await column_type(`${TABLE}_streams`, "source")).toBe("text");

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

    // …and the widened columns actually accept an identifier past the old
    // varchar(100) cap, including a derived `.autocloses` target.
    const long_stream = `legacy-${"x".repeat(140)}`;
    await store().commit(
      [{ stream: long_stream, msgs: [{ name: "opened", data: { n: 9 } }] }],
      {
        correlation: "c",
        causation: {},
        stream: long_stream,
      } as never
    );
    await store().subscribe([
      { stream: `__autoclose__:${long_stream}`, source: long_stream },
    ]);
  });

  // The advisory lock was keyed `schema.table`, but the statement it
  // guards is schema-wide. Stores sharing a schema with DIFFERENT table names
  // hashed to different keys, so their CREATE SCHEMA calls raced the catalog
  // and all but one failed. The existing case below shares a table, which is
  // exactly the configuration that already worked.
  it("serializes concurrent cold boots across different tables in one schema", async () => {
    await pool().query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const stores = ["t_a", "t_b", "t_c", "t_d", "t_e", "t_f"].map(
      (table) => new PostgresStore({ port: PORT, schema: SCHEMA, table })
    );
    const results = await Promise.allSettled(stores.map((s) => s.seed()));
    const failures = results.filter((r) => r.status === "rejected");
    await Promise.all(stores.map((s) => s.dispose()));
    expect(failures).toEqual([]);

    // Every table landed in the one schema.
    const { rows } = await pool().query(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2)`,
      [SCHEMA, ["t_a", "t_b", "t_c", "t_d", "t_e", "t_f"]]
    );
    expect(rows[0].n).toBe(6);
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
    await store().commit(
      [{ stream: "boot-1", msgs: [{ name: "opened", data: { n: 1 } }] }],
      {
        correlation: "c1",
        causation: { action: { name: "open", stream: "boot-1" } },
      } as never
    );
  });

  it("creates the schema on a connection that looked it up before it existed", async () => {
    // One connection, so the lookup and the seed share a catalog cache.
    const lone = new PostgresStore({
      port: PORT,
      schema: `${SCHEMA}_lone`,
      table: TABLE,
      max: 1,
    });
    const lone_pool = (lone as unknown as { _pool: any })._pool;
    // Looking the schema up while it's missing leaves a stale cache entry.
    await lone_pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}_lone" CASCADE`);
    // Another worker takes the schema lock and creates the schema while
    // this one waits on the lock.
    const other = new Client({
      host: "localhost",
      port: PORT,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${SCHEMA}_lone`,
      ]);
      await other.query(`CREATE SCHEMA "${SCHEMA}_lone"`);
      const seeding = lone.seed();
      await new Promise((r) => setTimeout(r, 100));
      await other.query("COMMIT");
      await expect(seeding).resolves.toBeUndefined();
    } finally {
      await other.end();
      await lone.drop();
      await lone_pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}_lone" CASCADE`);
      await lone.dispose();
    }
  });
});

/**
 * The retry-seed fix must take effect on databases created before
 * the change without an operator migration. `CREATE TABLE IF NOT EXISTS`
 * never rewrites an existing column default, so `subscribe` seeds `retry = -1`
 * explicitly rather than relying on the column default. This proves a
 * table from an older install (retry default 0) still gives new subscriptions
 * retry = -1, so their first claim returns retry = 0.
 */
describe("pg retry seed is migration-free", () => {
  const schema_name = schema("act_retry_compat");
  const table = "rc";
  const fqs = `"${schema_name}"."${table}_streams"`;

  it("subscribe seeds retry=-1 even when the column default is 0", async () => {
    const s = new PostgresStore({ port: PORT, schema: schema_name, table });
    const pool = new Pool({
      host: "localhost",
      port: PORT,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    try {
      await s.drop();
      await s.seed();
      // Simulate a deployment whose table still defaults retry to 0.
      await pool.query(`ALTER TABLE ${fqs} ALTER COLUMN retry SET DEFAULT 0`);
      await s.subscribe([{ stream: "compat-1" }]);
      const { rows } = await pool.query(
        `SELECT retry FROM ${fqs} WHERE stream = 'compat-1'`
      );
      expect(rows[0].retry).toBe(-1);
    } finally {
      await pool.end();
      await s.dispose();
    }
  });
});

/**
 * `streams.retry` was `smallint` (max 32767). `claim()` does
 * `retry = retry + 1` on every acquisition, and a persistently failing
 * `blockOnError: false` stream is re-claimed forever — so a zero-progress
 * poison stream marches its retry counter toward the smallint ceiling.
 * At 32768 the whole multi-stream claim UPDATE raised "smallint out of
 * range", killing `claim()` for the lane permanently. Widening the column
 * to `int` (via the additive seed ladder) lifts the ceiling to match the
 * unbounded SQLite/InMemory adapters.
 */
describe("pg streams.retry does not overflow at the smallint ceiling", () => {
  const schema_name = schema("act_retry_overflow");
  const table = "ro";
  const fqs = `"${schema_name}"."${table}_streams"`;

  it("claims a stream whose retry sits at the old smallint ceiling", async () => {
    const s = new PostgresStore({ port: PORT, schema: schema_name, table });
    const pool = new Pool({
      host: "localhost",
      port: PORT,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    try {
      await s.drop();
      await s.seed();
      await s.subscribe([{ stream: "poison-1" }]);
      // Park retry one below the old smallint ceiling. Before the fix the
      // very next claim's `retry + 1` overflows the smallint UPDATE.
      await pool.query(
        `UPDATE ${fqs} SET retry = 32767 WHERE stream = 'poison-1'`
      );

      // Commit an event so the stream lags and is claimable.
      const [e] = await s.commit(
        [{ stream: "poison-1", msgs: [{ name: "Poison", data: {} }] }],
        {
          correlation: "c",
          causation: {},
        } as never
      );

      await s.subscribe([{ stream: "poison-1", correlated_at: e.id }]);
      const leases = await s.claim(10, 0, "worker", 10_000);
      const lease = leases.find((l) => l.stream === "poison-1");
      expect(lease).toBeDefined();
      // Past the old ceiling — this row would have thrown pre-fix.
      expect(lease!.retry).toBe(32768);

      const { rows } = await pool.query(
        `SELECT retry FROM ${fqs} WHERE stream = 'poison-1'`
      );
      expect(rows[0].retry).toBe(32768);
    } finally {
      await pool.end();
      await s.dispose();
    }
  });
});
