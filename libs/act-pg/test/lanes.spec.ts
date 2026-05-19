/**
 * ACT-1103 — `PostgresStore` adapter-specific lane concerns. Generic
 * behavior (subscribe defaults, restart-driven UPSERT, claim filter,
 * StreamFilter.lane wiring across query_streams / prioritize / reset /
 * unblock) is covered by the shared TCK in
 * `libs/act-tck/src/store-tck.ts`. This file only validates concerns
 * unique to the Postgres adapter — the idempotent ALTER TABLE that
 * lets pre-1103 installations pick up the lane column without
 * operator intervention.
 */

import { dispose, store } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_lane_test";
const TABLE = "events";

describe("PostgresStore lane migration", () => {
  beforeEach(async () => {
    store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("seed adds the lane column to a pre-1103 streams table", async () => {
    // Hand-build the pre-1103 schema (no `lane` column), then call
    // seed() and verify the migration ran and existing rows inherit
    // the default lane.
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
