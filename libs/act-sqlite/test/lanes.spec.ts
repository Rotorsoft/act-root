/**
 * ACT-1103 — `SqliteStore` adapter-specific lane concerns. Generic
 * behavior (subscribe defaults, restart-driven UPSERT, claim filter,
 * StreamFilter.lane wiring across query_streams / prioritize / reset /
 * unblock) is covered by the shared TCK in
 * `libs/act-tck/src/store-tck.ts`. This file only validates concerns
 * unique to the SQLite adapter — the idempotent ALTER TABLE that lets
 * pre-1103 installations pick up the lane column without operator
 * intervention.
 */

import { dispose, store } from "@rotorsoft/act";
import { SqliteStore } from "../src/sqlite-store.js";

describe("SqliteStore lane migration", () => {
  beforeEach(async () => {
    store(new SqliteStore({ url: ":memory:" }));
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("seed adds the lane column to a pre-1103 streams table", async () => {
    // Hand-build the pre-1103 schema (no lane column), then call seed()
    // and verify the migration ran and existing rows pick up the
    // default lane.
    const client = (store() as any).client;
    await client.execute("DROP TABLE IF EXISTS streams");
    await client.execute(`
      CREATE TABLE streams (
        stream TEXT PRIMARY KEY,
        source TEXT,
        at INTEGER NOT NULL DEFAULT -1,
        retry INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        leased_by TEXT,
        leased_until TEXT,
        priority INTEGER NOT NULL DEFAULT 0
      )
    `);
    await client.execute(`INSERT INTO streams (stream) VALUES ('legacy')`);

    await store().seed();

    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), {
      stream: "legacy",
      stream_exact: true,
    });
    expect(seen[0].lane).toBe("default");
  });
});
