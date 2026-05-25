import { runStoreTck } from "@rotorsoft/act-tck";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";

runStoreTck({
  name: "InMemoryStore",
  factory: () => new InMemoryStore(),
  capabilities: { restore: true },
});
