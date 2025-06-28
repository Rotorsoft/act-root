import type {
  Committed,
  EventMeta,
  Message,
  Query,
  Schemas,
} from "./action.js";
import type { Fetch, Lease } from "./reaction.js";

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
 * Interface for an event store implementation.
 * Provides methods for seeding, dropping, committing, querying, and managing event streams.
 */
export interface Store extends Disposable {
  /**
   * Seed the store with initial data (optional, for testing/dev).
   */
  seed: () => Promise<void>;
  /**
   * Drop all data from the store (optional, for testing/dev).
   */
  drop: () => Promise<void>;

  /**
   * Commit one or more events to a stream.
   * @param stream - The stream name.
   * @param msgs - The events/messages to commit.
   * @param meta - Event metadata.
   * @param expectedVersion - Optional optimistic concurrency check.
   * @returns The committed events with metadata.
   * @throws ConcurrencyError if expectedVersion does not match.
   */
  commit: <E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) => Promise<Committed<E, keyof E>[]>;

  /**
   * Query events in the store, optionally filtered by query options.
   * @param callback - Function to call for each event.
   * @param query - Optional query options.
   * @param withSnaps - Whether to include snapshot events.
   * @returns The number of events processed.
   */
  query: <E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query,
    withSnaps?: boolean
  ) => Promise<number>;

  /**
   * Fetch new events from stream watermarks for processing.
   * @param limit - Maximum number of streams to fetch.
   * @returns Fetched streams and events.
   */
  fetch: <E extends Schemas>(limit: number) => Promise<Fetch<E>>;

  /**
   * Lease streams for processing (e.g., for distributed consumers).
   * @param leases - Lease requests.
   * @returns Granted leases.
   */
  lease: (leases: Lease[]) => Promise<Lease[]>;

  /**
   * Acknowledge completion of processing for leased streams.
   * @param leases - Leases to acknowledge.
   */
  ack: (leases: Lease[]) => Promise<void>;
}
