/**
 * The seed-sync contract: `seed()` IS the schema maintenance story —
 * additive, idempotent, lossless on any prior released shape. Act
 * deliberately has no migration framework; this suite pins the
 * guarantee against one canonical oldest-supported fixture.
 * (Concurrent-boot serialization is a Postgres concern — SQLite is
 * single-writer by design.)
 */

import { createClient } from "@libsql/client";
import { dispose, store } from "@rotorsoft/act";
import { SqliteStore } from "../src/sqlite-store.js";
import { rm_tmp_dbs, tmp_db_url } from "./tmp-db.js";

const client = () => (store() as unknown as { client: any }).client;

/** Hand-build the oldest supported schema shape with legacy rows. */
async function build_oldest_shape() {
  const c = client();
  // Events without the pii column.
  await c.execute(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      meta TEXT NOT NULL,
      created TEXT NOT NULL,
      UNIQUE(stream, version)
    )`);
  // Streams without priority / lane / deferred_at.
  await c.execute(`
    CREATE TABLE streams (
      stream TEXT PRIMARY KEY,
      source TEXT,
      at INTEGER NOT NULL DEFAULT -1,
      retry INTEGER NOT NULL DEFAULT -1,
      blocked INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      leased_until TEXT
    )`);
  // Legacy rows that must survive the upgrade untouched.
  await c.execute(`
    INSERT INTO events (stream, version, name, data, meta, created) VALUES
      ('legacy-1', 0, 'opened', '{"n":1}', '{"correlation":"c1","causation":{}}', '2024-01-01T00:00:00Z'),
      ('legacy-1', 1, 'closed', '{"n":2}', '{"correlation":"c2","causation":{}}', '2024-01-02T00:00:00Z')`);
  await c.execute(`INSERT INTO streams (stream, at) VALUES ('legacy-sub', 0)`);
}

const columns = async (table: string): Promise<string[]> => {
  const r = await client().execute(`PRAGMA table_info(${table})`);
  return r.rows.map((row: { name: string }) => row.name);
};

describe("SqliteStore seed-sync contract", () => {
  beforeEach(() => {
    // A private database per test: the fixture below hand-builds the
    // legacy schema with bare CREATE TABLE, which needs an empty file.
    store(new SqliteStore({ url: tmp_db_url() }));
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("upgrades the oldest supported shape losslessly and idempotently", async () => {
    await build_oldest_shape();

    await store().seed();

    // Additive columns landed on both tables.
    expect(await columns("events")).toContain("pii");
    const stream_cols = await columns("streams");
    for (const c of ["priority", "lane", "deferred_at"])
      expect(stream_cols).toContain(c);

    // Legacy rows are intact, with migration defaults applied.
    const events = await client().execute(
      "SELECT name, data, version, pii FROM events ORDER BY version"
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0].name).toBe("opened");
    expect(events.rows[0].pii).toBeNull();
    expect(JSON.parse(events.rows[1].data as string)).toEqual({ n: 2 });
    const seen: any[] = [];
    await store().query_streams((s) => seen.push(s), {
      stream: "legacy-sub",
      stream_exact: true,
    });
    expect(seen[0]).toMatchObject({ at: 0, priority: 0, lane: "default" });

    // A second seed is a no-op: same columns, same rows.
    await store().seed();
    expect((await columns("streams")).sort()).toEqual(stream_cols.sort());
    const again = await client().execute("SELECT count(*) AS n FROM events");
    expect(Number(again.rows[0].n)).toBe(2);
  });
});

/**
 * The retry-seed fix must take effect on databases created before
 * the change without an operator migration. SQLite cannot `ALTER COLUMN ...
 * SET DEFAULT`, so `subscribe` seeds `retry = -1` explicitly rather than
 * relying on the column default. This proves a table from an older install
 * (retry default 0) still gives new subscriptions retry = -1, so their first claim
 * returns retry = 0.
 */
const RETRY_DB_URL = tmp_db_url();

describe("sqlite retry seed is migration-free", () => {
  it("subscribe seeds retry=-1 even when the column default is 0", async () => {
    const s = new SqliteStore({ url: RETRY_DB_URL });
    const raw = createClient({ url: RETRY_DB_URL });
    try {
      await s.drop();
      await s.seed();
      // Simulate a table from an older install (retry default 0).
      await raw.execute("DROP TABLE streams");
      await raw.execute(`
        CREATE TABLE streams (
          stream TEXT PRIMARY KEY,
          source TEXT,
          at INTEGER NOT NULL DEFAULT -1,
          retry INTEGER NOT NULL DEFAULT 0,
          blocked INTEGER NOT NULL DEFAULT 0,
          error TEXT NOT NULL DEFAULT '',
          leased_by TEXT,
          leased_until TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          lane TEXT NOT NULL DEFAULT 'default'
        )
      `);
      await s.subscribe([{ stream: "compat-1" }]);
      const res = await raw.execute(
        "SELECT retry FROM streams WHERE stream = 'compat-1'"
      );
      expect(Number(res.rows[0].retry)).toBe(-1);
    } finally {
      raw.close();
      await s.dispose();
    }
  });
});

const CORRELATED_DB_URL = tmp_db_url();

/**
 * Migrating the correlate checkpoint to its keyed shape.
 *
 * SQLite cannot drop a primary key, so the old single-row table is rebuilt
 * rather than altered. The checkpoint has to survive that: losing it would
 * silently re-read the whole log on the next boot, or — worse, if it came back
 * as -1 against a large store — flood every subscription with re-marks.
 */
describe("correlated table migration", () => {
  it("rebuilds the older single-row table and keeps its checkpoint", async () => {
    const store = new SqliteStore({ url: CORRELATED_DB_URL });
    await store.drop();
    await store.seed();

    // Put the old shape back, exactly as an install predating the keyed checkpoint has it.
    const client = (store as unknown as { client: SqliteStore["client"] })
      .client;
    await client.execute("DROP TABLE correlated");
    await client.execute(
      "CREATE TABLE correlated (id INTEGER PRIMARY KEY CHECK (id = 0), at INTEGER NOT NULL DEFAULT -1)"
    );
    await client.execute("INSERT INTO correlated (id, at) VALUES (0, 4242)");

    // Seeding is the migration — seed-sync is this project's schema story.
    await store.seed();

    const columns = await client.execute("PRAGMA table_info(correlated)");
    const names = columns.rows.map((r) => r.name);
    expect(names).toContain("key");
    expect(names).toContain("leased_by");
    expect(names).not.toContain("id");

    // The old checkpoint lands on the shared row, which is the floor every
    // new correlator key inherits — so no worker re-reads history.
    const { correlated_at } = await store.subscribe([]);
    expect(correlated_at).toBe(4242);

    // And it is idempotent: seeding again against the new shape is a no-op.
    await store.seed();
    expect((await store.subscribe([])).correlated_at).toBe(4242);

    await store.dispose();
  });
});

afterAll(rm_tmp_dbs);
