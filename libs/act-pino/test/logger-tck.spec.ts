import { run_logger_tck } from "@rotorsoft/act-tck";
import { PinoLogger } from "../src/pino-logger.js";

run_logger_tck({
  name: "PinoLogger",
  factory: () => new PinoLogger({ level: "trace", pretty: false }),
});
