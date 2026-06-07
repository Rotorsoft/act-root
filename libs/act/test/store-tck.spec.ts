import { run_store_tck } from "@rotorsoft/act-tck";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";

run_store_tck({
  name: "InMemoryStore",
  factory: () => new InMemoryStore(),
  capabilities: { restore: true, pii_isolation: true },
});
