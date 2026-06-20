import { runStorePropertyTck } from "@rotorsoft/act-tck";
import { InMemoryStore } from "../../src/adapters/in-memory-store.js";

// Store-level property contract (commit version monotonicity, claim/lease
// no-leak, watermark monotonicity, block exclusion). The same suite runs
// against the durable adapters in libs/act-pg and libs/act-sqlite (ACT-982).
runStorePropertyTck({
  name: "InMemoryStore",
  factory: () => new InMemoryStore(),
  // numRuns omitted — exercises the default (100).
});
