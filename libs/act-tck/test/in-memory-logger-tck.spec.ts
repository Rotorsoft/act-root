import { ConsoleLogger } from "@rotorsoft/act";
import { runLoggerTck } from "../src/index.js";

runLoggerTck({
  name: "ConsoleLogger",
  factory: () => new ConsoleLogger({ level: "trace", pretty: false }),
});
