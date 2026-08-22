import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.js";

const DB_PATH = join(import.meta.dirname, "correlated-migration.db");

/**
 * Migrating the correlate checkpoint to its keyed shape (#1532).
 *
 * SQLite cannot drop a primary key, so the old single-row table is rebuilt
 * rather than altered. The checkpoint has to survive that: losing it would
 * silently re-read the whole log on the next boot, or — worse, if it came back
 * as -1 against a large store — flood every subscription with re-marks.
 */
describe("correlated table migration", () => {
  afterAll(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(DB_PATH + ext);
      } catch {
        // file may not exist
      }
    }
  });

  it("rebuilds the pre-#1532 single-row table and keeps its checkpoint", async () => {
    const store = new SqliteStore({ url: `file:${DB_PATH}` });
    await store.drop();
    await store.seed();

    // Put the old shape back, exactly as an install predating #1532 has it.
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
