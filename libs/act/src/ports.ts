import { pino } from "pino";
import { InMemoryCache } from "./adapters/InMemoryCache.js";
import { InMemoryStore } from "./adapters/InMemoryStore.js";
import { config } from "./config.js";
import type {
  Cache,
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
 * Registers resource cleanup functions for graceful shutdown.
 *
 * Disposers are called automatically when the process exits (SIGINT, SIGTERM)
 * or when manually triggered. They execute in reverse registration order,
 * allowing proper cleanup of dependent resources.
 *
 * Act automatically disposes registered stores and adapters. Use this function
 * to register additional cleanup for your own resources (database connections,
 * file handles, timers, etc.).
 *
 * @param disposer - Async function to call during cleanup
 * @returns Function to manually trigger disposal and exit
 *
 * @example Register custom resource cleanup
 * ```typescript
 * import { dispose } from "@rotorsoft/act";
 *
 * const redis = createRedisClient();
 *
 * dispose(async () => {
 *   console.log("Closing Redis connection...");
 *   await redis.quit();
 * });
 *
 * // On SIGINT/SIGTERM, Redis will be cleaned up automatically
 * ```
 *
 * @example Multiple disposers in order
 * ```typescript
 * import { dispose } from "@rotorsoft/act";
 *
 * const db = connectDatabase();
 * dispose(async () => {
 *   console.log("Closing database...");
 *   await db.close();
 * });
 *
 * const cache = connectCache();
 * dispose(async () => {
 *   console.log("Closing cache...");
 *   await cache.disconnect();
 * });
 *
 * // On exit: cache closes first, then database
 * ```
 *
 * @example Manual cleanup trigger
 * ```typescript
 * import { dispose } from "@rotorsoft/act";
 *
 * const shutdown = dispose(async () => {
 *   await cleanup();
 * });
 *
 * // Manually trigger cleanup and exit
 * process.on("SIGUSR2", async () => {
 *   console.log("Manual shutdown requested");
 *   await shutdown("EXIT");
 * });
 * ```
 *
 * @example With error handling
 * ```typescript
 * import { dispose } from "@rotorsoft/act";
 *
 * dispose(async () => {
 *   try {
 *     await expensiveCleanup();
 *   } catch (error) {
 *     console.error("Cleanup failed:", error);
 *     // Error doesn't prevent other disposers from running
 *   }
 * });
 * ```
 *
 * @see {@link Disposer} for disposer function type
 * @see {@link Disposable} for disposable interface
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
 * Gets or injects the singleton event store.
 *
 * By default, Act uses an in-memory store suitable for development and testing.
 * For production, inject a persistent store like PostgresStore before building
 * your application.
 *
 * **Important:** Store injection must happen before creating any Act instances.
 * Once set, the store cannot be changed without restarting the application.
 *
 * @param adapter - Optional store implementation to inject
 * @returns The singleton store instance
 *
 * @example Using default in-memory store
 * ```typescript
 * import { store } from "@rotorsoft/act";
 *
 * const currentStore = store(); // Returns InMemoryStore
 * ```
 *
 * @example Injecting PostgreSQL store
 * ```typescript
 * import { store } from "@rotorsoft/act";
 * import { PostgresStore } from "@rotorsoft/act-pg";
 *
 * // Inject before building your app
 * store(new PostgresStore({
 *   host: "localhost",
 *   port: 5432,
 *   database: "myapp",
 *   user: "postgres",
 *   password: "secret",
 *   schema: "public",
 *   table: "events"
 * }));
 *
 * // Now build your app - it will use PostgreSQL
 * const app = act()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @example With environment-based configuration
 * ```typescript
 * import { store } from "@rotorsoft/act";
 * import { PostgresStore } from "@rotorsoft/act-pg";
 *
 * if (process.env.NODE_ENV === "production") {
 *   store(new PostgresStore({
 *     host: process.env.DB_HOST,
 *     port: parseInt(process.env.DB_PORT || "5432"),
 *     database: process.env.DB_NAME,
 *     user: process.env.DB_USER,
 *     password: process.env.DB_PASSWORD
 *   }));
 * }
 * // Development uses default in-memory store
 * ```
 *
 * @example Testing with fresh store
 * ```typescript
 * import { store } from "@rotorsoft/act";
 *
 * beforeEach(async () => {
 *   // Reset store between tests
 *   await store().seed();
 * });
 *
 * afterAll(async () => {
 *   // Cleanup
 *   await store().drop();
 * });
 * ```
 *
 * @see {@link Store} for the store interface
 * @see {@link InMemoryStore} for the default implementation
 * @see {@link PostgresStore} for production use
 */
export const store = port(function store(adapter?: Store) {
  return adapter || new InMemoryStore();
});

/**
 * Gets or injects the singleton cache.
 *
 * By default, Act uses an in-memory LRU cache. For distributed deployments,
 * inject a Redis-backed cache before building your application.
 *
 * Cache unifies snapshotting — `snap()` writes to cache instead of the event store,
 * and `load()` checks cache before querying the store for tail events.
 *
 * @param adapter - Optional cache implementation to inject
 * @returns The singleton cache instance
 */
export const cache = port(function cache(adapter?: Cache) {
  return adapter || new InMemoryCache();
});

/**
 * Tracer builder for logging fetches, leases, etc.
 */
export function build_tracer(logLevel: LogLevel): {
  fetched: <E extends Schemas>(fetched: Fetch<E>) => void;
  correlated: (streams: Array<{ stream: string; source?: string }>) => void;
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
      correlated: (streams: Array<{ stream: string; source?: string }>) => {
        const data = streams.map(({ stream }) => stream).join(" ");
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
