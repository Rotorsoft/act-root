import { runCacheTck } from "@rotorsoft/act-tck";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";

runCacheTck({
  name: "InMemoryCache",
  factory: () => new InMemoryCache({ maxSize: 1000 }),
});
