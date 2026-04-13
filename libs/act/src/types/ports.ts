/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types and interfaces for event store ports and disposables in the Act Framework.
 */
import type {
  Committed,
  EventMeta,
  Message,
  Query,
  Schema,
  Schemas,
} from "./action.js";
import type { Lease } from "./reaction.js";

/**
 * A function that disposes of a resource asynchronously.
 * @returns Promise that resolves when disposal is complete.
 */
export type Disposer = () => Promise<void>;

/**
 * An object that can be disposed of asynchronously.
 */
export type Disposable = { dispose: Disposer };

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Minimal logger port compatible with pino, winston, bunyan, and console.
 *
 * Each log method accepts either:
 * - `(msg: string)` — plain message
 * - `(obj: unknown, msg?: string)` — structured data with optional message
 *
 * Implementations should respect `level` to gate output.
 *
 * @see {@link ConsoleLogger} for the default implementation
 * @see {@link https://www.npmjs.com/package/@rotorsoft/act-pino | @rotorsoft/act-pino} for the Pino adapter
 */
export interface Logger extends Disposable {
  level: string;
  fatal(obj: unknown, msg?: string): void;
  fatal(msg: string): void;
  error(obj: unknown, msg?: string): void;
  error(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  warn(msg: string): void;
  info(obj: unknown, msg?: string): void;
  info(msg: string): void;
  debug(obj: unknown, msg?: string): void;
  debug(msg: string): void;
  trace(obj: unknown, msg?: string): void;
  trace(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Result of a {@link Store.truncate} operation, keyed by stream name.
 * Each entry contains the number of deleted events and the committed
 * seed event (snapshot or tombstone).
 */
export type TruncateResult = Map<
  string,
  { deleted: number; committed: Committed<Schemas, keyof Schemas> }
>;

/**
 * Interface for event store implementations.
 *
 * The Store interface defines the contract for persistence adapters in Act.
 * Implementations must provide event storage, querying, and distributed processing
 * capabilities through leasing and watermark tracking.
 *
 * Act includes two built-in implementations:
 * - **InMemoryStore**: For development and testing
 * - **PostgresStore**: For production use with PostgreSQL
 *
 * Custom stores can be implemented for other databases or event log systems.
 *
 * @example Using a custom store
 * ```typescript
 * import { store } from "@rotorsoft/act";
 * import { PostgresStore } from "@rotorsoft/act-pg";
 *
 * // Replace the default in-memory store
 * store(new PostgresStore({
 *   host: "localhost",
 *   port: 5432,
 *   database: "myapp",
 *   user: "postgres",
 *   password: "secret"
 * }));
 *
 * const app = act()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @see {@link InMemoryStore} for the default implementation
 * @see {@link PostgresStore} for the PostgreSQL implementation
 */
export interface Store extends Disposable {
  /**
   * Initializes or resets the store.
   *
   * Used primarily for testing to ensure a clean state between tests.
   * For production stores, this might create necessary tables or indexes.
   *
   * @example
   * ```typescript
   * // Reset store between tests
   * beforeEach(async () => {
   *   await store().seed();
   * });
   * ```
   */
  seed: () => Promise<void>;
  /**
   * Drops all data from the store.
   *
   * Dangerous operation that deletes all events and state. Use with extreme caution,
   * primarily for testing or development environments.
   *
   * @example
   * ```typescript
   * // Clean up after tests
   * afterAll(async () => {
   *   await store().drop();
   * });
   * ```
   */
  drop: () => Promise<void>;

  /**
   * Commits one or more events to a stream atomically.
   *
   * This is the core method for persisting events. It must:
   * - Assign global sequence IDs to events
   * - Increment the stream version
   * - Check optimistic concurrency if expectedVersion is provided
   * - Store events atomically (all or nothing)
   * - Attach metadata (id, stream, version, created timestamp)
   *
   * @template E - Event schemas
   * @param stream - The stream ID to commit to
   * @param msgs - Array of messages (events) to commit
   * @param meta - Event metadata (correlation, causation)
   * @param expectedVersion - Expected current version for optimistic concurrency
   * @returns Array of committed events with full metadata
   *
   * @throws {ConcurrencyError} If expectedVersion doesn't match current version
   *
   * @example
   * ```typescript
   * const events = await store().commit(
   *   "user-123",
   *   [{ name: "UserCreated", data: { email: "user@example.com" } }],
   *   { correlation: "req-456", causation: { action: {...} } },
   *   0 // Expect version 0 (new stream)
   * );
   * ```
   */
  commit: <E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) => Promise<Committed<E, keyof E>[]>;

  /**
   * Queries events from the store with optional filtering.
   *
   * Calls the callback for each matching event. The callback approach allows
   * processing large result sets without loading everything into memory.
   *
   * @template E - Event schemas
   * @param callback - Function invoked for each matching event
   * @param query - Optional filter criteria
   * @param query.stream - Filter by stream ID
   * @param query.name - Filter by event name
   * @param query.after - Return events after this ID
   * @param query.before - Return events before this ID
   * @param query.limit - Maximum number of events to return
   * @returns Total number of events processed
   *
   * @example Query all events for a stream
   * ```typescript
   * let count = 0;
   * await store().query(
   *   (event) => {
   *     console.log(event.name, event.data);
   *     count++;
   *   },
   *   { stream: "user-123" }
   * );
   * console.log(`Found ${count} events`);
   * ```
   */
  query: <E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) => Promise<number>;

  /**
   * Atomically discovers and leases streams for reaction processing.
   *
   * Combines {@link poll} and {@link lease} into a single operation, eliminating
   * the race condition where another worker can grab a stream between poll and lease.
   *
   * PostgresStore uses `FOR UPDATE SKIP LOCKED` for zero-contention competing
   * consumer semantics — workers never block each other, each grabbing different
   * streams atomically. InMemoryStore fuses its poll+lease logic equivalently.
   *
   * Used by `Act.drain()` as the primary stream acquisition method.
   *
   * @param lagging - Max streams from the lagging frontier (ascending watermark)
   * @param leading - Max streams from the leading frontier (descending watermark)
   * @param by - Unique lease holder identifier (UUID)
   * @param millis - Lease duration in milliseconds
   * @returns Array of successfully leased streams with metadata
   *
   * @example
   * ```typescript
   * const leased = await store().claim(5, 5, randomUUID(), 10000);
   * leased.forEach(({ stream, at, lagging }) => {
   *   console.log(`Leased ${stream} at ${at} (lagging: ${lagging})`);
   * });
   * ```
   *
   * @see {@link subscribe} for registering new streams (used by correlate)
   * @see {@link ack} for acknowledging completion
   * @see {@link block} for blocking failed streams
   */
  claim: (
    lagging: number,
    leading: number,
    by: string,
    millis: number
  ) => Promise<Lease[]>;

  /**
   * Registers streams for event processing.
   *
   * Upserts stream entries so they become visible to {@link claim}. Used by
   * `correlate()` to register dynamically discovered reaction target streams.
   *
   * Also returns the current maximum watermark across all subscribed streams,
   * used internally for correlation checkpoint initialization on cold start.
   *
   * @param streams - Streams to register with optional source hint
   * @returns `subscribed` count of newly registered streams, `watermark` max `at` across all streams
   *
   * @example
   * ```typescript
   * const { subscribed, watermark } = await store().subscribe([
   *   { stream: "stats-user-1", source: "user-1" },
   *   { stream: "stats-user-2", source: "user-2" },
   * ]);
   * ```
   *
   * @see {@link claim} for discovering and leasing registered streams
   */
  subscribe: (
    streams: Array<{ stream: string; source?: string }>
  ) => Promise<{ subscribed: number; watermark: number }>;

  /**
   * Acknowledges successful processing of leased streams.
   *
   * Updates the watermark to indicate events have been processed successfully.
   * Releases the lease so other workers can process subsequent events.
   *
   * @param leases - Leases to acknowledge with updated watermarks
   * @returns Acknowledged leases
   *
   * @example
   * ```typescript
   * const leased = await store().claim(5, 5, randomUUID(), 10000);
   * // Process events up to ID 150
   * await store().ack(leased.map(l => ({ ...l, at: 150 })));
   * ```
   *
   * @see {@link claim} for acquiring leases
   */
  ack: (leases: Lease[]) => Promise<Lease[]>;

  /**
   * Blocks streams after persistent processing failures.
   *
   * Blocked streams won't be returned by {@link claim} until manually unblocked.
   * This prevents poison messages from repeatedly failing and consuming resources.
   *
   * Streams are typically blocked when:
   * - Max retries reached
   * - `blockOnError` option is true
   * - Handler throws an error
   *
   * @param leases - Leases to block with error messages
   * @returns Blocked leases
   *
   * @example
   * ```typescript
   * try {
   *   await processEvents(lease);
   *   await store().ack([lease]);
   * } catch (error) {
   *   if (lease.retry >= 3) {
   *     await store().block([{
   *       ...lease,
   *       error: error.message
   *     }]);
   *   }
   * }
   * ```
   *
   * @see {@link claim} for lease management
   */
  block: (
    leases: Array<Lease & { error: string }>
  ) => Promise<Array<Lease & { error: string }>>;

  /**
   * Resets watermarks for the given streams to -1, making them eligible
   * for replay from the beginning. Also clears retry, blocked, error,
   * and lease state so the streams can be claimed immediately.
   *
   * Used by `Act.rebuild()` to replay events through updated projections.
   *
   * @param streams - Stream names to reset
   * @returns Count of streams that were actually reset
   *
   * @example
   * ```typescript
   * const count = await store().reset(["my-projection"]);
   * console.log(`Reset ${count} streams for replay`);
   * ```
   *
   * @see {@link Act.rebuild} for the high-level rebuild API
   */
  reset: (streams: string[]) => Promise<number>;

  /**
   * Atomically truncates streams and seeds each with a final event.
   *
   * For each target, in a single transaction:
   * 1. Deletes all events for the stream
   * 2. Removes the stream's entry from the streams table
   * 3. Inserts a `__snapshot__` (when `snapshot` is provided) or
   *    `__tombstone__` event as the sole event on the stream
   *
   * @param targets - Streams to truncate with optional snapshot state and meta
   * @returns Map keyed by stream name, each entry with `deleted` count and `committed` event
   *
   * @see {@link Act.close} for the high-level close-the-books API
   */
  truncate: (
    targets: Array<{
      stream: string;
      snapshot?: Schema;
      meta?: EventMeta;
    }>
  ) => Promise<TruncateResult>;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * A cached snapshot entry for a stream.
 *
 * @template TState - The state schema type
 */
export interface CacheEntry<TState extends Schema> {
  readonly state: TState;
  readonly version: number;
  readonly event_id: number;
  readonly patches: number;
  readonly snaps: number;
}

/**
 * Cache port for storing stream snapshots in-process.
 *
 * Implementations should provide fast key-value access with bounded memory.
 * The async interface is forward-compatible with external caches (e.g., Redis).
 *
 * @template TState - The state schema type
 */
export interface Cache extends Disposable {
  get<TState extends Schema>(
    stream: string
  ): Promise<CacheEntry<TState> | undefined>;
  set<TState extends Schema>(
    stream: string,
    entry: CacheEntry<TState>
  ): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
