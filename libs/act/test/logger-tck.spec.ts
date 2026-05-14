import { runLoggerTck } from "@rotorsoft/act-tck";
import { ConsoleLogger } from "../src/adapters/console-logger.js";

runLoggerTck({
  name: "ConsoleLogger",
  factory: () => new ConsoleLogger({ level: "trace", pretty: false }),
});
