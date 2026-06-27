/**
 * ACT-1032 — guard the #1024 partial snapshot index.
 *
 * #1024 added a partial index over snapshot rows only so the
 * `with_snaps` "resume at the latest snapshot" floor —
 *   `SELECT COALESCE(MAX(id), -1) FROM events WHERE stream=? AND name='__snapshot__'`
 * — is an O(log n) index seek instead of a per-stream scan. The index
 * lives in `seed()`:
 *   `CREATE INDEX <table>_snapshot_ix ON <table> (stream, id)
 *      WHERE name = '__snapshot__';`
 *
 * The believed optimization is "the planner actually uses that index."
 * This test proves it the only way that survives a silent regression
 * (e.g. someone drops the index, or changes the floor query so the
 * partial index no longer matches): EXPLAIN the floor subquery against a
 * populated, ANALYZE'd table and assert the plan is an INDEX scan on
 * `<table>_snapshot_ix`, not a Seq Scan on the events table.
 *
 * Uses one Postgres on :5431 with a dedicated schema; short run, dropped
 * on teardown.
 */
import { SNAP_EVENT } from "@rotorsoft/act";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_snapshot_explain";
const TABLE = "events";
const FQT = `"${SCHEMA}"."${TABLE}"`;
const SNAPSHOT_IX = `${TABLE}_snapshot_ix`;
const TARGET = "stream-with-snaps";

describe("PostgresStore #1024 partial snapshot index (EXPLAIN)", () => {
  let store: PostgresStore;
  // `_pool` is private; the test reaches in to run raw EXPLAIN / seed SQL.
  let pool: { query: (sql: string, params?: unknown[]) => Promise<any> };

  beforeAll(async () => {
    store = new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE });
    pool = (store as unknown as { _pool: typeof pool })._pool;
    await store.drop();
    await store.seed();

    // Populate enough rows that a sequential scan is a genuinely worse
    // plan than the index seek — so the planner choosing the index is a
    // real signal, not a small-table accident.
    //   - 5000 noise events spread across 100 streams (no snapshots)
    //   - 200 regular events on the target stream
    //   - 50 snapshot events on the target stream (versions offset so the
    //     UNIQUE(stream, version) index isn't violated)
    await pool.query(
      `INSERT INTO ${FQT} (name, data, stream, version, meta)
       SELECT 'Incremented', '{}'::jsonb, 'noise-' || (g % 100), g, '{}'::jsonb
       FROM generate_series(1, 5000) g`
    );
    await pool.query(
      `INSERT INTO ${FQT} (name, data, stream, version, meta)
       SELECT 'Incremented', '{}'::jsonb, $1, g, '{}'::jsonb
       FROM generate_series(1, 200) g`,
      [TARGET]
    );
    await pool.query(
      `INSERT INTO ${FQT} (name, data, stream, version, meta)
       SELECT $1, '{}'::jsonb, $2, 1000 + g, '{}'::jsonb
       FROM generate_series(1, 50) g`,
      [SNAP_EVENT, TARGET]
    );
    // The planner needs fresh stats to cost the index vs the seq scan.
    await pool.query(`ANALYZE ${FQT}`);
  });

  afterAll(async () => {
    await store.drop();
    await store.dispose();
  });

  it("the index exists with the expected partial predicate", async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = $2`,
      [SCHEMA, SNAPSHOT_IX]
    );
    expect(rows).toHaveLength(1);
    // Partial index keyed on (stream, id), predicate on the snapshot name.
    expect(rows[0].indexdef).toContain("(stream");
    expect(rows[0].indexdef.toLowerCase()).toContain("where");
    expect(rows[0].indexdef).toContain(SNAP_EVENT);
  });

  it("EXPLAIN of the snapshot floor query uses the partial index, not a seq scan", async () => {
    // The exact subquery PostgresStore.query() runs for the with_snaps
    // resume floor.
    const { rows } = await pool.query(
      `EXPLAIN SELECT COALESCE(MAX(id), -1) FROM ${FQT}
       WHERE stream = $1 AND name = '${SNAP_EVENT}'`,
      [TARGET]
    );
    const plan = rows
      .map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"])
      .join("\n");

    // The optimization: the planner reaches the snapshot's MAX(id) through
    // the partial index, never a full-table sequential scan.
    expect(plan).toContain(SNAPSHOT_IX);
    expect(plan).not.toMatch(/Seq Scan on .*events/i);
  });
});
