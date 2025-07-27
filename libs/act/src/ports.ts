import { pino } from "pino";
import { InMemoryStore } from "./adapters/InMemoryStore.js";
import { config } from "./config.js";
import type {
  Disposable,
  Disposer,
  Fetch,
  Lease,
  LogLevel,
  Schemas,
  Store,
} from "./types/index.js";

/**
 * Port and adapter utilities for logging, store management, and resource disposal.
 *
 * Provides singleton store and logger instances, and helpers for resource lifecycle management.
 *
 * - Use `store()` to get or inject the event store (in-memory or persistent).
 * - Use `logger` for structured logging.
 * - Use `dispose()` to register resource disposers for graceful shutdown.
 *
 * @module ports
 */

/**
 * List of exit codes for process termination.
 */
export const ExitCodes = ["ERROR", "EXIT"] as const;

/**
 * Type for allowed exit codes.
 */
export type ExitCode = (typeof ExitCodes)[number];

/**
 * Singleton logger instance (Pino).
 *
 * Use for structured logging throughout your application.
 *
 * @example
 * logger.info("Application started");
 */
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

/**
 * Helper to create a singleton port (adapter) with optional injection.
 *
 * @param injector The function that creates the port/adapter
 * @returns A function to get or inject the singleton instance
 *
 * @example
 * const store = port((adapter) => adapter || new InMemoryStore());
 * const myStore = store();
 */
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
 * Registers resource disposers that are triggered on process exit.
 *
 * @param disposer The disposer function to register
 * @returns A function that triggers all registered disposers and terminates the process
 *
 * @example
 * dispose(async () => { await myResource.close(); });
 */
export function dispose(
  disposer?: Disposer
): (code?: ExitCode) => Promise<void> {
  disposer && disposers.push(disposer);
  return disposeAndExit;
}

/**
 * Special event name for snapshot events in the event store.
 */
export const SNAP_EVENT = "__snapshot__";

/**
 * Singleton event store port. By default, uses the in-memory store.
 *
 * You can inject a persistent store (e.g., Postgres) by calling `store(myAdapter)`.
 *
 * @example
 * const myStore = store();
 * const customStore = store(new MyCustomStore());
 */
export const store = port(function store(adapter?: Store) {
  return adapter || new InMemoryStore();
});

/**
 * Tracer builder for logging fetches, leases, etc.
 */
export function build_tracer(logLevel: LogLevel): {
  fetched: <E extends Schemas>(fetched: Fetch<E>) => void;
  correlated: (leases: Lease[]) => void;
  leased: (leases: Lease[]) => void;
  acked: (leases: Lease[]) => void;
  blocked: (leases: Array<Lease & { error: string }>) => void;
} {
  if (logLevel === "trace") {
    return {
      fetched: <E extends Schemas>(fetched: Fetch<E>) => {
        const data = Object.fromEntries(
          fetched.map(({ stream, source, events }) => {
            const key = source ? `${stream}<-${source}` : stream;
            const value = Object.fromEntries(
              events.map(({ id, stream, name }) => [id, { [stream]: name }])
            );
            return [key, value];
          })
        );
        logger.trace(data, "⚡️ fetch");
      },
      correlated: (leases: Lease[]) => {
        const data = leases.map(({ stream }) => stream).join(" ");
        logger.trace(`⚡️ correlate ${data}`);
      },
      leased: (leases: Lease[]) => {
        const data = Object.fromEntries(
          leases.map(({ stream, at, retry }) => [stream, { at, retry }])
        );
        logger.trace(data, "⚡️ lease");
      },
      acked: (leases: Lease[]) => {
        const data = Object.fromEntries(
          leases.map(({ stream, at, retry }) => [stream, { at, retry }])
        );
        logger.trace(data, "⚡️ ack");
      },
      blocked: (leases: Array<Lease & { error: string }>) => {
        const data = Object.fromEntries(
          leases.map(({ stream, at, retry, error }) => [
            stream,
            { at, retry, error },
          ])
        );
        logger.trace(data, "⚡️ block");
      },
    };
  } else {
    return {
      fetched: () => {},
      correlated: () => {},
      leased: () => {},
      acked: () => {},
      blocked: () => {},
    };
  }
}
