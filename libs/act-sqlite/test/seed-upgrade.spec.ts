/**
 * The seed-sync contract: `seed()` IS the schema maintenance story —
 * additive, idempotent, lossless on any prior released shape. Act
 * deliberately has no migration framework; this suite pins the
 * guarantee against one canonical oldest-supported fixture.
 * (Concurrent-boot serialization is a Postgres concern — SQLite is
 * single-writer by design.)
 */

import { dispose, store } from "@rotorsoft/act";
import { SqliteStore } from "../src/sqlite-store.js";

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
    store(new SqliteStore({ url: ":memory:" }));
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
