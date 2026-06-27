import { InMemoryStore } from "@rotorsoft/act";
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { PostgresStore } from "../src/index.js";

// Cross-adapter differential (#1030): drive the same seeded workload
// against the in-memory reference and Postgres, then compare normalized
// outputs. Dedicated schema/table so the harness's drop+seed can't
// clobber the example-based TCK running in a parallel worker.
runStoreDifferentialTck({
  name: "InMemory vs Postgres",
  // Explicit seed + stream count (the sqlite differential exercises the
  // defaults) so both arms of the option fallbacks stay covered.
  seed: 0x1030,
  streams: 5,
  stores: [
    { name: "InMemoryStore", factory: () => new InMemoryStore() },
    {
      name: "PostgresStore",
      factory: () =>
        new PostgresStore({
          port: 5431,
          schema: "tck_diff",
          table: "tck_diff",
        }),
    },
  ],
});
