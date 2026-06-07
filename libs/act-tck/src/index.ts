/**
 * @packageDocumentation
 * @module @rotorsoft/act-tck
 *
 * Test Compatibility Kit for {@link Store}, {@link Cache}, and {@link Logger}
 * ports of `@rotorsoft/act`.
 *
 * A TCK turns each port from "interface plus tribal knowledge" into an
 * executable contract a third-party adapter can validate itself against.
 * Drop one or more `run*Tck` invocations into your adapter's test suite,
 * point them at your factory, and the TCK exercises every method on the
 * corresponding interface.
 *
 * The in-tree adapters (`InMemoryStore`, `InMemoryCache`, `ConsoleLogger`,
 * `PostgresStore`, `SqliteStore`, and `@rotorsoft/act-pino`) are the first
 * customers of this package — if any of them stop honoring the contract,
 * the TCK fails first.
 *
 * @example Store adapter
 * ```ts
 * import { runStoreTck } from "@rotorsoft/act-tck";
 * import { MyStore } from "../src/MyStore.js";
 *
 * runStoreTck({
 *   name: "MyStore",
 *   factory: () => new MyStore({ ... }),
 *   capabilities: { notify: true },
 * });
 * ```
 *
 * @example Cache adapter
 * ```ts
 * import { runCacheTck } from "@rotorsoft/act-tck";
 * import { RedisCache } from "../src/RedisCache.js";
 *
 * runCacheTck({
 *   name: "RedisCache",
 *   factory: () => new RedisCache({ url: process.env.REDIS_URL }),
 * });
 * ```
 *
 * @example Logger adapter
 * ```ts
 * import { runLoggerTck } from "@rotorsoft/act-tck";
 * import { MyLogger } from "../src/MyLogger.js";
 *
 * runLoggerTck({
 *   name: "MyLogger",
 *   factory: () => new MyLogger({ level: "trace" }),
 * });
 * ```
 *
 * ## Port evolution
 *
 * When a port interface in `libs/act/src/types/ports.ts` changes — a new
 * method, a tightened contract, a new optional flag — extend the matching
 * `run*Tck` here so every adapter is forced to keep up. Gate new optional
 * methods behind a flag in the relevant `Capabilities` type so existing
 * adapters keep passing until they explicitly opt in.
 */

// Re-export the port contracts so adapter authors only need a single
// import line in their test files (`@rotorsoft/act-tck`) rather than
// reaching into `@rotorsoft/act/types` for the interfaces and the TCK
// for the run* functions. Same types — keeps the two paths from
// drifting in adapter-author code.
export type {
  Cache,
  CacheEntry,
  Logger,
  Store,
  StoreNotification,
} from "@rotorsoft/act/types";
export type { CacheTckOptions } from "./cache-tck.js";
export { runCacheTck } from "./cache-tck.js";
export type { CounterEvents } from "./fixtures/events.js";
export {
  COUNTER_EVENT_NAMES,
  CounterSchemas,
  Decremented,
  Incremented,
  Reset,
} from "./fixtures/events.js";
export type {
  CommittedCounterEvent,
  CounterMessage,
} from "./fixtures/helpers.js";
export {
  actor,
  collect,
  dec,
  inc,
  reset,
  uid,
} from "./fixtures/helpers.js";
export type { LoggerTckOptions } from "./logger-tck.js";
export { runLoggerTck } from "./logger-tck.js";
export type { StoreCapabilities, StoreTckOptions } from "./store-tck.js";
export { runStoreTck } from "./store-tck.js";
