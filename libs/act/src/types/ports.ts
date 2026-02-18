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
  Schemas,
} from "./action.js";
import type { Lease, Poll } from "./reaction.js";

/**
 * A function that disposes of a resource asynchronously.
 * @returns Promise that resolves when disposal is complete.
 */
export type Disposer = () => Promise<void>;

/**
 * An object that can be disposed of asynchronously.
 */
export type Disposable = { dispose: Disposer };

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
   * Polls for streams that need reaction processing.
   *
   * Returns streams that have uncommitted events, ordered by their watermark.
   * Uses a dual-frontier approach:
   * - **Lagging**: New or behind streams (ascending watermark)
   * - **Leading**: Active streams (descending watermark)
   *
   * Only returns unblocked streams that aren't currently leased.
   *
   * @param lagging - Max streams to return from lagging frontier
   * @param leading - Max streams to return from leading frontier
   * @returns Array of poll results with stream, source, watermark, and lag status
   *
   * @example
   * ```typescript
   * const polled = await store().poll(5, 5); // 5 lagging + 5 leading
   * polled.forEach(({ stream, at, lagging }) => {
   *   console.log(`${stream} at ${at} (lagging: ${lagging})`);
   * });
   * ```
   *
   * @see {@link Lease} for lease management
   */
  poll: (lagging: number, leading: number) => Promise<Poll[]>;

  /**
   * Acquires leases for exclusive stream processing.
   *
   * Leasing prevents multiple workers from processing the same stream concurrently.
   * Only grants leases if:
   * - Stream isn't currently leased by another worker
   * - Lease hasn't expired
   * - Stream isn't blocked due to errors
   *
   * @param leases - Array of lease requests
   * @param millis - Lease duration in milliseconds
   * @returns Array of successfully granted leases
   *
   * @example
   * ```typescript
   * const granted = await store().lease([
   *   { stream: "user-123", by: workerId, at: 0, retry: 0, lagging: false }
   * ], 10000); // 10 second lease
   *
   * if (granted.length > 0) {
   *   // Process events...
   *   await store().ack(granted);
   * }
   * ```
   *
   * @see {@link poll} for finding streams to lease
   * @see {@link ack} for acknowledging completion
   */
  lease: (leases: Lease[], millis: number) => Promise<Lease[]>;

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
   * const leased = await store().lease([...], 10000);
   * // Process events up to ID 150
   * await store().ack(leased.map(l => ({ ...l, at: 150 })));
   * ```
   *
   * @see {@link lease} for acquiring leases
   */
  ack: (leases: Lease[]) => Promise<Lease[]>;

  /**
   * Blocks streams after persistent processing failures.
   *
   * Blocked streams won't be returned by {@link poll} until manually unblocked.
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
   * @see {@link lease} for lease management
   */
  block: (
    leases: Array<Lease & { error: string }>
  ) => Promise<Array<Lease & { error: string }>>;
}
