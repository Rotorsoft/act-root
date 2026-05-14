import { runStoreTck } from "@rotorsoft/act-tck";
import { PostgresStore } from "../src/index.js";

runStoreTck({
  name: "PostgresStore",
  factory: () =>
    new PostgresStore({
      port: 5431,
      schema: "tck",
      table: "tck_store",
      notify: true,
    }),
  capabilities: { notify: true },
});
