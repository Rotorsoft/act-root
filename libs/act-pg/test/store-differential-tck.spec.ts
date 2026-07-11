import { InMemoryStore } from "@rotorsoft/act";
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { PostgresStore } from "../src/index.js";

// Cross-adapter differential (#1030, fuzz workloads #1057): drive a family
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
  // #1199 — PG's `names: []` returns ALL (drops the filter) while the
  // InMemory reference returns NONE, and the falsy-zero `before`/`after: 0`
  // guards differ. Skip only those edge-input query cases until #1199 lands
  // the `!== undefined` guards + defined `names: []` semantics; the rest of
  // the query matrix runs. PG's `~` is case-sensitive, so the mixed-case
  // pattern cases run unconditionally (no `caseInsensitivePatterns` gate).
  skip: { queryEdgeInputs: true },
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
