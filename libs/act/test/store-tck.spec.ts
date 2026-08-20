import { runStoreTck } from "@rotorsoft/act-tck";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";

runStoreTck({
  name: "InMemoryStore",
  factory: () => new InMemoryStore(),
  // InMemoryStore is zero-config by definition — the default is the
  // only configuration, and it must round-trip (#1443).
  default_factory: () => new InMemoryStore(),
  capabilities: {
    restore: true,
    retire: true,
    pii_isolation: true,
    concurrent_claim: true,
    source_matches: true,
    pattern_claim_source: true,
    work_set: true,
  },
});
