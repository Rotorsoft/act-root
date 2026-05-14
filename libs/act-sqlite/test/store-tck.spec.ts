import { runStoreTck } from "@rotorsoft/act-tck";
import { SqliteStore } from "../src/index.js";

runStoreTck({
  name: "SqliteStore",
  factory: () => new SqliteStore({ url: "file:tck-store.db" }),
});
