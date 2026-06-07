import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { runStoreTck } from "@rotorsoft/act-tck";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";

// Co-locate the SQLite scratch file with the test that owns it so
// the WAL/SHM sidecars don't leak into the repo root.
const DB_PATH = join(import.meta.dirname, "tck-store.db");

runStoreTck({
  name: "SqliteStore",
  factory: () => new SqliteStore({ url: `file:${DB_PATH}` }),
  capabilities: { restore: true },
});

// The TCK's own `afterAll` only calls `store.dispose()`; the file +
// WAL/SHM sidecars are the spec file's responsibility to remove.
afterAll(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + ext);
    } catch {
      // file may not exist
    }
  }
});
