import { runStorePropertyTck } from "@rotorsoft/act-tck";
import { PostgresStore } from "../src/index.js";

// Dedicated schema/table so this file's drop+seed-per-run reset can't
// clobber the example-based TCK running in a parallel worker. Reduced
// numRuns because each run pays a full schema rebuild against real PG.
runStorePropertyTck({
  name: "PostgresStore",
  factory: () =>
    new PostgresStore({ port: 5431, schema: "tck_prop", table: "tck_prop" }),
  numRuns: 15,
  // Each run is a schema rebuild plus a dozen-plus round trips against a real
  // server, so wall time tracks I/O and whatever else the machine is doing.
  // Vitest's 5s default is fine in isolation and not under the full parallel
  // suite, where this file timed out intermittently rather than failing an
  // assertion.
  timeoutMs: 30_000,
});
