/**
 * ACT-1032 — guard the #1024 partial snapshot index (SQLite).
 *
 * #1024 added a partial index over snapshot rows only so the
 * `with_snaps` "resume at the latest snapshot" floor —
 *   `SELECT COALESCE(MAX(id), -1) FROM events WHERE stream = ? AND name = '__snapshot__'`
 * — is an O(log n) index seek instead of a per-stream table scan. The
 * index lives in `seed()`:
 *   `CREATE INDEX idx_events_snapshot ON events(stream, id)
 *      WHERE name = '__snapshot__';`
 *
 * The believed optimization is "the planner actually uses that index."
 * This proves it via `EXPLAIN QUERY PLAN`: against a populated, ANALYZE'd
 * table, the floor query must SEARCH using `idx_events_snapshot`, never a
 * full `SCAN events`. A silent regression (index dropped, or floor query
 * reshaped so the partial predicate no longer matches) flips the plan to
 * a scan and fails here.
 *
 * In-memory SQLite — no file, no shared state, fast.
 */
import { SNAP_EVENT } from "@rotorsoft/act";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.js";

const SNAPSHOT_IX = "idx_events_snapshot";
const TARGET = "stream-with-snaps";

type Client = {
  execute: (q: string | { sql: string; args: unknown[] }) => Promise<{
    rows: Array<Record<string, unknown>>;
  }>;
};

describe("SqliteStore #1024 partial snapshot index (EXPLAIN QUERY PLAN)", () => {
  let store: SqliteStore;
  let client: Client;

  beforeAll(async () => {
    store = new SqliteStore({ url: ":memory:" });
    client = (store as unknown as { client: Client }).client;
    await store.seed();

    // Populate enough rows that a full table scan is genuinely worse than
    // the index seek, so the planner choosing the index is a real signal.
    //   - 5000 noise events across 100 streams (no snapshots)
    //   - 200 regular events on the target stream
    //   - 50 snapshot events on the target stream (versions offset to
    //     dodge the UNIQUE(stream, version) constraint)
    await client.execute(`
      INSERT INTO events (name, data, stream, version, meta, created)
      WITH RECURSIVE c(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM c WHERE g < 5000)
      SELECT 'Incremented', '{}', 'noise-' || (g % 100), g, '{}', '2020-01-01'
      FROM c
    `);
    await client.execute({
      sql: `
        INSERT INTO events (name, data, stream, version, meta, created)
        WITH RECURSIVE c(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM c WHERE g < 200)
        SELECT 'Incremented', '{}', ?, g, '{}', '2020-01-01'
        FROM c
      `,
      args: [TARGET],
    });
    await client.execute({
      sql: `
        INSERT INTO events (name, data, stream, version, meta, created)
        WITH RECURSIVE c(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM c WHERE g < 50)
        SELECT ?, '{}', ?, 1000 + g, '{}', '2020-01-01'
        FROM c
      `,
      args: [SNAP_EVENT, TARGET],
    });
    // The planner needs stats to cost the index vs the scan.
    await client.execute("ANALYZE");
  });

  afterAll(async () => {
    await store.dispose();
  });

  it("the partial snapshot index exists with the snapshot-name predicate", async () => {
    const { rows } = await client.execute({
      sql: `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
      args: [SNAPSHOT_IX],
    });
    expect(rows).toHaveLength(1);
    const sql = String(rows[0].sql);
    expect(sql).toContain("(stream");
    expect(sql.toUpperCase()).toContain("WHERE");
    expect(sql).toContain(SNAP_EVENT);
  });

  it("EXPLAIN QUERY PLAN of the snapshot floor query searches the partial index, not a full scan", async () => {
    // The exact subquery SqliteStore.query() runs for the with_snaps floor.
    const { rows } = await client.execute({
      sql: `EXPLAIN QUERY PLAN
            SELECT COALESCE(MAX(id), -1) FROM events
            WHERE stream = ? AND name = '${SNAP_EVENT}'`,
      args: [TARGET],
    });
    const plan = rows.map((r) => String(r.detail)).join("\n");

    // The optimization: reach MAX(id) through the partial index, never a
    // full sequential table scan ("SCAN events").
    expect(plan).toContain(SNAPSHOT_IX);
    expect(plan).not.toContain("SCAN events");
  });
});
