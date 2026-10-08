/**
 * `SqliteStore` priority: the seed migration. The portable priority
 * contract (max on subscribe, prioritize filters, claim order) lives in the
 * store TCK.
 */

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { SqliteStore } from "../src/sqlite-store.js";

describe("SqliteStore priority migration", () => {
  let s: SqliteStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/act-priority-${randomUUID()}.db`;
    s = new SqliteStore({ url: `file:${dbPath}` });
    await s.seed();
  });

  afterEach(async () => {
    await s.dispose();
    try {
      unlinkSync(dbPath);
    } catch {
      // file may not exist
    }
  });

  it("seed migration is idempotent — running seed twice doesn't error", async () => {
    // Migration uses ALTER TABLE ADD COLUMN inside a try/catch so
    // re-seeding a fresh-schema DB shouldn't throw on the duplicate
    // column.
    await expect(s.seed()).resolves.toBeUndefined();
  });
});
