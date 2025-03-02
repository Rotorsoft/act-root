import { config } from "./config";
import { disposeAndExit, logger } from "./ports";

/** @module act */
export * from "./act";
export * from "./builder";
export * from "./ports";
export * from "./types";
export * from "./utils";
export { config };

// exit on signals
process.once("SIGINT", async (arg?: any) => {
  logger.info(arg, "SIGINT");
  await disposeAndExit("EXIT");
});
process.once("SIGTERM", async (arg?: any) => {
  logger.info(arg, "SIGTERM");
  await disposeAndExit("EXIT");
});
process.once("uncaughtException", async (arg?: any) => {
  logger.error(arg, "Uncaught Exception");
  await disposeAndExit("ERROR");
});
process.once("unhandledRejection", async (arg?: any) => {
  logger.error(arg, "Unhandled Rejection");
  await disposeAndExit("ERROR");
});
