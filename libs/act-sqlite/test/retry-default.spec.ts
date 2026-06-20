import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";

/**
 * ACT-980: the retry-seed fix must take effect on databases created before
 * the change without an operator migration. SQLite cannot `ALTER COLUMN ...
 * SET DEFAULT`, so `subscribe` seeds `retry = -1` explicitly rather than
 * relying on the column default. This proves a pre-ACT-980 table (retry
 * default 0) still gives new subscriptions retry = -1, so their first claim
 * returns retry = 0.
 */
const DB_PATH = join(import.meta.dirname, "retry-default.db");

describe("sqlite retry seed is migration-free", () => {
  it("subscribe seeds retry=-1 even when the column default is 0", async () => {
    const s = new SqliteStore({ url: `file:${DB_PATH}` });
    const raw = createClient({ url: `file:${DB_PATH}` });
    try {
      await s.drop();
      await s.seed();
      // Simulate a table created before ACT-980 (retry default 0).
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

afterAll(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + ext);
    } catch {
      // file may not exist
    }
  }
});
