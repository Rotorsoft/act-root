import { InMemoryCache } from "@rotorsoft/act";
import { runCacheTck } from "../src/index.js";

runCacheTck({
  name: "InMemoryCache",
  factory: () => new InMemoryCache({ maxSize: 1000 }),
});
