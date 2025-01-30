import pino from "pino";
import { InMemoryApp } from "./adapters/InMemoryApp";
import { InMemoryStore } from "./adapters/InMemoryStore";
import { Builder } from "./builder";
import { config as c } from "./config";
import type { Disposable, Disposer, ExitCode, Store } from "./types";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: c().env === "development",
      ignore: "pid,hostname,name",
      errorLikeObjectKeys: ["e", "err", "error"],
      sync: c().env === "test",
      singleLine: c().env !== "development"
    }
  },
  level: c().env === "test" ? "fatal" : c().logLevel
});

const adapters = new Map<string, Disposable>();
export function port<T extends Disposable>(adapterFactory: (arg?: T) => T) {
  return function (arg?: T): T {
    if (!adapters.has(adapterFactory.name)) {
      const adapter = adapterFactory(arg);
      adapters.set(adapterFactory.name, adapter);
      logger.info(undefined, `>>> ${adapter.name}`);
    }
    return adapters.get(adapterFactory.name) as T;
  };
}

const disposers: Disposer[] = [];
export async function disposeAndExit(code: ExitCode = "EXIT"): Promise<void> {
  // ignore when errors are caught in production
  if (code === "ERROR" && c().env === "production") return;

  await Promise.all(disposers.map((disposer) => disposer()));
  await Promise.all(
    [...adapters].reverse().map(async ([, adapter]) => {
      await adapter.dispose();
      logger.info(undefined, `<<< ${adapter.name}`);
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
export const config = port(function config() {
  return { ...c(), name: "config", dispose: () => Promise.resolve() };
});

export const app = port(function app<T extends Builder>(app?: T): T {
  return app || (new InMemoryApp() as T);
});

export const store = port(function store(store?: Store) {
  return store || InMemoryStore();
});
