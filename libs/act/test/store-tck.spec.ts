import { runStoreTck } from "@rotorsoft/act-tck";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";

runStoreTck({
  name: "InMemoryStore",
  factory: () => new InMemoryStore(),
  // InMemoryStore is zero-config by definition — the default is the
  // only configuration, and it must round-trip.
  default_factory: () => new InMemoryStore(),
  capabilities: {
    restore: true,
    lease_correlation: true,
    pii_isolation: true,
    concurrent_claim: true,
    source_matches: true,
    work_set: true,
  },
});
