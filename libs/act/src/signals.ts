import { disposeAndExit, log } from "./ports.js";

// Resolve the logger lazily inside each handler — calling log() here at
// module load would register the default ConsoleLogger before user code
// can inject (port singletons are first-call-wins).
process.once("SIGINT", async (arg?: any) => {
  log().info(arg, "SIGINT");
  await disposeAndExit("EXIT");
});
process.once("SIGTERM", async (arg?: any) => {
  log().info(arg, "SIGTERM");
  await disposeAndExit("EXIT");
});
process.once("uncaughtException", async (arg?: any) => {
  log().error(arg, "Uncaught Exception");
  await disposeAndExit("ERROR");
});
process.once("unhandledRejection", async (arg?: any) => {
  log().error(arg, "Unhandled Rejection");
  await disposeAndExit("ERROR");
});
