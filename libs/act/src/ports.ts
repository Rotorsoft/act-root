import { ConsoleLogger } from "./adapters/ConsoleLogger.js";
import { InMemoryCache } from "./adapters/InMemoryCache.js";
import { InMemoryStore } from "./adapters/InMemoryStore.js";
import { config } from "./config.js";
import type {
  Cache,
  Disposable,
  Disposer,
  Fetch,
  Lease,
  Logger,
  LogLevel,
  Schemas,
  Store,
} from "./types/index.js";

/**
 * Port/adapter infrastructure for the Act framework.
 *
 * All infrastructure concerns (logging, storage, caching) are managed as
 * singleton adapters injected via port functions. Each port follows the same
 * pattern: first call wins with a sensible default, optional adapter injection.
 *
 * - `log()` — structured logging (default: ConsoleLogger)
 * - `store()` — event persistence (default: InMemoryStore)
 * - `cache()` — state checkpoints (default: InMemoryCache)
 * - `dispose()` — register cleanup functions for graceful shutdown
 *
 * @module ports
 */

/**
 * List of exit codes for process termination.
 */
export const ExitCodes = ["ERROR", "EXIT"] as const;

/**
 * Type for allowed exit codes.
 *
 * - `"ERROR"` — abnormal termination (uncaught exception, unhandled rejection)
 * - `"EXIT"` — clean shutdown (SIGINT, SIGTERM, or manual trigger)
 */
export type ExitCode = (typeof ExitCodes)[number];

// ---------------------------------------------------------------------------
// Port factory
// ---------------------------------------------------------------------------

/**
 * Factory function that creates or returns the injected adapter.
 * @internal
 */
type Injector<Port extends Disposable> = (adapter?: Port) => Port;

/** Singleton adapter registry, keyed by injector function name. */
const adapters = new Map<string, Disposable>();

/**
 * Creates a singleton port with optional adapter injection.
 *
 * The first call initializes the adapter (using the provided adapter or the
 * injector's default). Subsequent calls return the cached singleton. Adapters
 * are disposed in reverse registration order during {@link disposeAndExit}.
 *
 * @param injector - Named function that creates the default adapter
 * @returns Port function: call with no args to get the singleton, or pass an
 *          adapter on the first call to override the default
 *
 * @example
 * ```typescript
 * const store = port(function store(adapter?: Store) {
 *   return adapter || new InMemoryStore();
 * });
 * const s = store(); // InMemoryStore
 * ```
 */
export function port<Port extends Disposable>(injector: Injector<Port>) {
  return function (adapter?: Port): Port {
    if (!adapters.has(injector.name)) {
      const injected = injector(adapter);
      adapters.set(injector.name, injected);
      console.log(`[act] + ${injector.name}:${injected.constructor.name}`);
    }
    return adapters.get(injector.name) as Port;
  };
}

// ---------------------------------------------------------------------------
// Ports: log, store, cache
// ---------------------------------------------------------------------------

/**
 * Gets or injects the singleton logger.
 *
 * By default, Act uses a built-in {@link ConsoleLogger} that emits JSON lines
 * in production (compatible with GCP, AWS CloudWatch, Datadog) and colorized
 * output in development — zero external dependencies.
 *
 * For pino, inject a `PinoLogger` from `@rotorsoft/act-pino` before building
 * your application.
 *
 * @param adapter - Optional logger implementation to inject
 * @returns The singleton logger instance
 *
 * @example Default console logger
 * ```typescript
 * import { log } from "@rotorsoft/act";
 * const logger = log();
 * logger.info("Application started");
 * ```
 *
 * @example Injecting pino
 * ```typescript
 * import { log } from "@rotorsoft/act";
 * import { PinoLogger } from "@rotorsoft/act-pino";
 * log(new PinoLogger({ level: "debug", pretty: true }));
 * ```
 *
 * @see {@link Logger} for the interface contract
 * @see {@link ConsoleLogger} for the default implementation
 */
export const log = port(function log(adapter?: Logger) {
  const cfg = config();
  return (
    adapter ||
    new ConsoleLogger({
      level: cfg.logLevel,
      pretty: cfg.env !== "production",
    })
  );
});

/**
 * Gets or injects the singleton event store.
 *
 * By default, Act uses an {@link InMemoryStore} suitable for development and
 * testing. For production, inject a persistent store like `PostgresStore` from
 * `@rotorsoft/act-pg` before building your application.
 *
 * **Important:** Store injection must happen before creating any Act instances.
 * Once set, the store cannot be changed without restarting the application.
 *
 * @param adapter - Optional store implementation to inject
 * @returns The singleton store instance
 *
 * @example Default in-memory store
 * ```typescript
 * import { store } from "@rotorsoft/act";
 * const s = store();
 * ```
 *
 * @example Injecting PostgreSQL
 * ```typescript
 * import { store } from "@rotorsoft/act";
 * import { PostgresStore } from "@rotorsoft/act-pg";
 *
 * store(new PostgresStore({
 *   host: "localhost",
 *   port: 5432,
 *   database: "myapp",
 *   user: "postgres",
 *   password: "secret",
 * }));
 * ```
 *
 * @see {@link Store} for the interface contract
 * @see {@link InMemoryStore} for the default implementation
 */
export const store = port(function store(adapter?: Store) {
  return adapter || new InMemoryStore();
});

/**
 * Gets or injects the singleton cache.
 *
 * By default, Act uses an {@link InMemoryCache} (LRU, maxSize 1000). For
 * distributed deployments, inject a Redis-backed cache before building your
 * application.
 *
 * @param adapter - Optional cache implementation to inject
 * @returns The singleton cache instance
 *
 * @see {@link Cache} for the interface contract
 * @see {@link InMemoryCache} for the default implementation
 */
export const cache = port(function cache(adapter?: Cache) {
  return adapter || new InMemoryCache();
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/** Registered cleanup functions, executed in reverse order during shutdown. */
const disposers: Disposer[] = [];

/**
 * Disposes all registered adapters and disposers, then exits the process.
 *
 * Execution order:
 * 1. Custom disposers (registered via {@link dispose}) — in reverse order
 * 2. Port adapters (log, store, cache) — in reverse registration order
 * 3. Adapter registry is cleared
 * 4. Process exits (skipped in test environment)
 *
 * In production, `"ERROR"` exits are silently ignored to avoid crashing on
 * transient failures (e.g. an uncaught promise in a non-critical path).
 *
 * @param code - Exit code: `"EXIT"` for clean shutdown (exit 0),
 *               `"ERROR"` for abnormal termination (exit 1)
 */
export async function disposeAndExit(code: ExitCode = "EXIT"): Promise<void> {
  if (code === "ERROR" && config().env === "production") return;

  await Promise.all(disposers.map((disposer) => disposer()));
  await Promise.all(
    [...adapters.values()].reverse().map(async (adapter) => {
      await adapter.dispose();
      console.log(`[act] - ${adapter.constructor.name}`);
    })
  );
  adapters.clear();
  config().env !== "test" && process.exit(code === "ERROR" ? 1 : 0);
}

/**
 * Registers a cleanup function for graceful shutdown.
 *
 * Disposers are called automatically on SIGINT, SIGTERM, uncaught exceptions,
 * and unhandled rejections. They execute in reverse registration order before
 * port adapters are disposed.
 *
 * @param disposer - Async function to call during cleanup. Omit to get a
 *                   reference to {@link disposeAndExit} without registering.
 * @returns Function to manually trigger disposal and exit
 *
 * @example
 * ```typescript
 * import { dispose } from "@rotorsoft/act";
 *
 * const db = connectDatabase();
 * dispose(async () => await db.close());
 *
 * // In tests
 * afterAll(async () => await dispose()());
 * ```
 *
 * @see {@link disposeAndExit} for the full shutdown sequence
 */
export function dispose(
  disposer?: Disposer
): (code?: ExitCode) => Promise<void> {
  disposer && disposers.push(disposer);
  return disposeAndExit;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Event name used internally for snapshot events in the event store.
 * Snapshot events store a full state checkpoint, enabling efficient cold-start
 * recovery without replaying the entire event stream.
 */
export const SNAP_EVENT = "__snapshot__";

/**
 * Event name used internally for tombstone events in the event store.
 * A tombstone marks a stream as permanently closed — no further writes
 * are permitted until the stream is explicitly restarted via `close()`.
 *
 * @see {@link Act.close} for the close-the-books API
 */
export const TOMBSTONE_EVENT = "__tombstone__";

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

/**
 * Creates a tracer for detailed drain-cycle logging.
 *
 * When `logLevel` is `"trace"`, returns functions that log fetch, correlate,
 * lease, ack, and block operations. At any other level, returns no-op
 * functions to avoid overhead.
 *
 * @param logLevel - Current log level from configuration
 * @returns Object with tracer methods (active or no-op)
 *
 * @internal Used by {@link Act} to instrument drain cycles.
 */
export function build_tracer(logLevel: LogLevel): {
  fetched: <E extends Schemas>(fetched: Fetch<E>) => void;
  correlated: (streams: Array<{ stream: string; source?: string }>) => void;
  leased: (leases: Lease[]) => void;
  acked: (leases: Lease[]) => void;
  blocked: (leases: Array<Lease & { error: string }>) => void;
} {
  if (logLevel === "trace") {
    const logger = log();
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
        logger.trace(data, ">> fetch");
      },
      correlated: (streams: Array<{ stream: string; source?: string }>) => {
        const data = streams.map(({ stream }) => stream).join(" ");
        logger.trace(`>> correlate ${data}`);
      },
      leased: (leases: Lease[]) => {
        const data = Object.fromEntries(
          leases.map(({ stream, at, retry }) => [stream, { at, retry }])
        );
        logger.trace(data, ">> lease");
      },
      acked: (leases: Lease[]) => {
        const data = Object.fromEntries(
          leases.map(({ stream, at, retry }) => [stream, { at, retry }])
        );
        logger.trace(data, ">> ack");
      },
      blocked: (leases: Array<Lease & { error: string }>) => {
        const data = Object.fromEntries(
          leases.map(({ stream, at, retry, error }) => [
            stream,
            { at, retry, error },
          ])
        );
        logger.trace(data, ">> block");
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
