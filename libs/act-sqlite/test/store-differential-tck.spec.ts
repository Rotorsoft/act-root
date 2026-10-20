import { InMemoryStore } from "@rotorsoft/act";
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";
import { rm_tmp_dbs, tmp_db_url } from "./tmp-db.js";

// Cross-adapter differential: drive the same seeded workload
// against the in-memory reference and SQLite, then compare normalized
// outputs. Dedicated scratch file so the harness's drop+seed is isolated
// from the example-based TCK running in a parallel worker.
const DB_URL = tmp_db_url();

runStoreDifferentialTck({
  name: "InMemory vs Sqlite",
  // Explicit here (the PG differential omits it to exercise the `?? true`
  // default) — both stores implement the optional forget_pii surface.
  piiIsolation: true,
  stores: [
    { name: "InMemoryStore", factory: () => new InMemoryStore() },
    {
      name: "SqliteStore",
      factory: () => new SqliteStore({ url: DB_URL }),
    },
  ],
});

// The harness only disposes the stores; the file + WAL/SHM sidecars are
// this spec's responsibility to remove.
afterAll(rm_tmp_dbs);
