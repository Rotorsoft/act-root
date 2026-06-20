import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { runStorePropertyTck } from "@rotorsoft/act-tck";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";

// Dedicated file so the drop+seed-per-run reset is isolated from the
// example-based TCK running in a parallel worker.
const DB_PATH = join(import.meta.dirname, "property-store.db");

runStorePropertyTck({
  name: "SqliteStore",
  factory: () => new SqliteStore({ url: `file:${DB_PATH}` }),
  numRuns: 30,
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
