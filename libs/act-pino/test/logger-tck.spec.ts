import { runLoggerTck } from "@rotorsoft/act-tck";
import { PinoLogger } from "../src/pino-logger.js";

runLoggerTck({
  name: "PinoLogger",
  factory: () => new PinoLogger({ level: "trace", pretty: false }),
});
