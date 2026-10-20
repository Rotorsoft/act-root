import { runStorePropertyTck } from "@rotorsoft/act-tck";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";
import { rm_tmp_dbs, tmp_db_url } from "./tmp-db.js";

// Dedicated file so the drop+seed-per-run reset is isolated from the
// example-based TCK running in a parallel worker.
const DB_URL = tmp_db_url();

runStorePropertyTck({
  name: "SqliteStore",
  factory: () => new SqliteStore({ url: DB_URL }),
  numRuns: 30,
  // Same reasoning as act-pg: each run is a rebuild plus many round trips, and
  // vitest's 5s default is tight under the full parallel suite.
  timeoutMs: 30_000,
});

afterAll(rm_tmp_dbs);
