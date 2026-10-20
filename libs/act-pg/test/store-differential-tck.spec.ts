import { InMemoryStore } from "@rotorsoft/act";
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { PostgresStore } from "../src/index.js";
import { schema } from "./schema.js";

// Cross-adapter differential: drive a family
// of randomized seeded workloads against the in-memory reference and
// Postgres, then compare normalized outputs. Dedicated schema/table so the
// harness's drop+seed can't clobber the example-based TCK running in a
// parallel worker.
runStoreDifferentialTck({
  name: "InMemory vs Postgres",
  // Explicit seed + stream count + run count (the sqlite differential
  // exercises the defaults) so both arms of the option fallbacks stay
  // covered. Fewer runs keeps the durable round-trips bounded.
  seed: 0x1030,
  streams: 5,
  runs: 5,
  // `after: 0` is an absolute id bound, and the stores number events from
  // different origins (InMemory from 0, Postgres from 1), so it selects a
  // different window on each. Skip the edge-input query cases for that; the
  // rest of the query matrix runs. PG's `~` is case-sensitive, so the
  // mixed-case pattern cases run unconditionally.
  skip: { queryEdgeInputs: true },
  stores: [
    { name: "InMemoryStore", factory: () => new InMemoryStore() },
    {
      name: "PostgresStore",
      factory: () =>
        new PostgresStore({
          port: 5431,
          schema: schema("tck_diff"),
          table: "tck_diff",
        }),
    },
  ],
});
