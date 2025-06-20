import { pino } from "pino";
import { InMemoryStore } from "./adapters/InMemoryStore.js";
import { config } from "./config.js";
import type { Disposable, Disposer, Store } from "./types/index.js";

/**
 * Port and adapter utilities for logging, store management, and resource disposal.
 * Provides singleton store and logger instances.
 */

export const ExitCodes = ["ERROR", "EXIT"] as const;
export type ExitCode = (typeof ExitCodes)[number];

export const logger = pino({
  transport:
    config().env !== "production"
      ? {
          target: "pino-pretty",
          options: {
            ignore: "pid,hostname",
            singleLine: config().logSingleLine,
            colorize: true,
          },
        }
      : undefined,
  level: config().logLevel,
});

type Injector<Port extends Disposable> = (adapter?: Port) => Port;
const adapters = new Map<string, Disposable>();
export function port<Port extends Disposable>(injector: Injector<Port>) {
  return function (adapter?: Port): Port {
    if (!adapters.has(injector.name)) {
      const injected = injector(adapter);
      adapters.set(injector.name, injected);
      logger.info(`🔌 injected ${injector.name}:${injected.constructor.name}`);
    }
    return adapters.get(injector.name) as Port;
  };
}

const disposers: Disposer[] = [];
export async function disposeAndExit(code: ExitCode = "EXIT"): Promise<void> {
  // ignore when errors are caught in production
  if (code === "ERROR" && config().env === "production") return;

  await Promise.all(disposers.map((disposer) => disposer()));
  await Promise.all(
    [...adapters.values()].reverse().map(async (adapter) => {
      await adapter.dispose();
      logger.info(`🔌 disposed ${adapter.constructor.name}`);
    })
  );
  adapters.clear();
  config().env !== "test" && process.exit(code === "ERROR" ? 1 : 0);
}

/**
 * Registers resource disposers that are triggered on process exit
 * @param disposer the disposer function
 * @returns a function that triggers all registered disposers and terminates the process
 */
export function dispose(
  disposer?: Disposer
): (code?: ExitCode) => Promise<void> {
  disposer && disposers.push(disposer);
  return disposeAndExit;
}

// singleton ports
export const SNAP_EVENT = "__snapshot__";
export const store = port(function store(adapter?: Store) {
  return adapter || new InMemoryStore();
});
