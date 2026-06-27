import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStore } from "@rotorsoft/act";
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";

// Cross-adapter differential (#1030): drive the same seeded workload
// against the in-memory reference and SQLite, then compare normalized
// outputs. Dedicated scratch file so the harness's drop+seed is isolated
// from the example-based TCK running in a parallel worker.
const DB_PATH = join(import.meta.dirname, "differential-store.db");

runStoreDifferentialTck({
  name: "InMemory vs Sqlite",
  stores: [
    { name: "InMemoryStore", factory: () => new InMemoryStore() },
    {
      name: "SqliteStore",
      factory: () => new SqliteStore({ url: `file:${DB_PATH}` }),
    },
  ],
});

// The harness only disposes the stores; the file + WAL/SHM sidecars are
// this spec's responsibility to remove.
afterAll(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + ext);
    } catch {
      // file may not exist
    }
  }
});
