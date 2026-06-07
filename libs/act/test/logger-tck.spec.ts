import { run_logger_tck } from "@rotorsoft/act-tck";
import { ConsoleLogger } from "../src/adapters/console-logger.js";

run_logger_tck({
  name: "ConsoleLogger",
  factory: () => new ConsoleLogger({ level: "trace", pretty: false }),
});
