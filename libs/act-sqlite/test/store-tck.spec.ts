import { runStoreTck } from "@rotorsoft/act-tck";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";
import { rm_tmp_dbs, tmp_db_url } from "./tmp-db.js";

// Co-locate the SQLite scratch file with the test that owns it so
// the WAL/SHM sidecars don't leak into the repo root.
const DB_URL = tmp_db_url();

runStoreTck({
  name: "SqliteStore",
  factory: () => new SqliteStore({ url: DB_URL }),
  // There is no zero-config SqliteStore: a store has to be told where to
  // write, and every in-memory default libSQL can serve is either broken
  // or process-global (#1443). The TCK asserts the refusal is loud.
  default_factory: () => new SqliteStore(undefined as never),
  capabilities: {
    restore: true,
    lease_correlation: true,
    pii_isolation: true,
    rejects_nonportable_claim_source: true,
    work_set: true,
  },
});

// The TCK's own `afterAll` only calls `store.dispose()`; the database
// files are the spec file's responsibility to remove.
afterAll(rm_tmp_dbs);
