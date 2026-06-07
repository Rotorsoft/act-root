import { run_cache_tck } from "@rotorsoft/act-tck";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";

run_cache_tck({
  name: "InMemoryCache",
  factory: () => new InMemoryCache({ maxSize: 1000 }),
});
