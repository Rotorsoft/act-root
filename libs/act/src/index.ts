import { config } from "./config.js";
import { disposeAndExit, logger } from "./ports.js";

/**
 * @module act
 * Main entry point for the Act framework. Re-exports all core APIs.
 */
export * from "./act-builder.js";
export * from "./act.js";
export * from "./ports.js";
export * from "./state-builder.js";
export * from "./types/index.js";
export * from "./utils.js";
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
