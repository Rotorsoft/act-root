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
   * @returns The number of events processed.
   */
  query: <E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) => Promise<number>;

  /**
   * Polls the store for unblocked streams needing processing, ordered by lease watermark.
   * @param lagging - Max number of streams to poll in ascending order.
   * @param leading - Max number of streams to poll in descending order.
   * @returns The polled streams.
   */
  poll: (lagging: number, leading: number) => Promise<Poll[]>;

  /**
   * Lease streams for processing (e.g., for distributed consumers).
   * @param leases - Lease requests for streams, including end-of-lease watermark, lease holder, and source stream.
   * @param millis - Lease duration in milliseconds.
   * @returns Granted leases.
   */
  lease: (leases: Lease[], millis: number) => Promise<Lease[]>;

  /**
   * Acknowledge completion of processing for leased streams.
   * @param leases - Leases to acknowledge, including lease holder and last processed watermark.
   */
  ack: (leases: Lease[]) => Promise<Lease[]>;

  /**
   * Block a stream for processing after failing to process and reaching max retries with blocking enabled.
   * @param leases - Leases to block, including lease holder and last error message.
   * @returns Blocked leases.
   */
  block: (
    leases: Array<Lease & { error: string }>
  ) => Promise<Array<Lease & { error: string }>>;
}
