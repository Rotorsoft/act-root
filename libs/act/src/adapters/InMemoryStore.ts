/**
 * @packageDocumentation
 * @module act/adapters
 * In-memory event store adapter for the Act Framework.
 *
 * This adapter implements the Store interface and is suitable for development, testing, and demonstration purposes.
 * All data is stored in memory and lost on process exit.
 *
 * @category Adapters
 */
import { SNAP_EVENT } from "../ports.js";
import { ConcurrencyError } from "../types/errors.js";
import type {
  Committed,
  EventMeta,
  Lease,
  Message,
  Query,
  Schemas,
  SourceStream,
  Store,
} from "../types/index.js";
import { sleep } from "../utils.js";

/**
 * @internal
 * Represents an in-memory stream for event processing and leasing.
 */
class InMemoryStream {
  stream: string;
  source: SourceStream | undefined;
  at = -1;
  retry = -1;
  blocked = false;
  leased_by: string | undefined = undefined;
  leased_until: Date | undefined = undefined;

  constructor(lease: Lease) {
    this.stream = lease.stream;
    this.source = lease.source;
  }

  get is_avaliable() {
    return (
      !this.blocked && (!this.leased_until || this.leased_until <= new Date())
    );
  }

  /**
   * Attempt to lease this stream for processing.
   * @param lease - Lease request.
   * @returns The granted lease or undefined if blocked.
   */
  lease(lease: Lease, leaseMillis: number): Lease | undefined {
    if (this.is_avaliable && lease.at > this.at) {
      this.leased_by = lease.by;
      this.leased_until = new Date(Date.now() + leaseMillis);
      return {
        stream: this.stream,
        source: this.source,
        by: lease.by,
        at: lease.at,
        retry: this.retry + 1,
        block: false,
      };
    }
  }

  /**
   * Acknowledge completion of processing for this stream.
   * @param lease - Lease to acknowledge.
   */
  ack(lease: Lease) {
    if (this.leased_by === lease.by && lease.at >= this.at) {
      this.leased_by = undefined;
      this.leased_until = undefined;
      this.retry = lease.retry;
      this.blocked = lease.block;
      if (!this.blocked && !lease.error) {
        this.at = lease.at;
        this.retry = 0;
      }
    }
  }
}

/**
 * @category Adapters
 * @see Store
 *
 * In-memory implementation of the Store interface.
 *
 * Suitable for development, testing, and demonstration. Not for production use.
 * All events and streams are stored in memory and lost on process exit.
 *
 * @example
 *   const store = new InMemoryStore();
 *   await store.commit('streamA', [{ name: 'event', data: {} }], meta);
 */
export class InMemoryStore implements Store {
  // stored events
  private _events: Committed<Schemas, keyof Schemas>[] = [];
  // stored stream positions and other metadata
  private _streams: Map<string, InMemoryStream> = new Map();

  constructor(private _leaseMillis: number = 5_000) {}

  /**
   * Dispose of the store and clear all events.
   * @returns Promise that resolves when disposal is complete.
   */
  async dispose() {
    await sleep();
    this._events.length = 0;
  }

  /**
   * Seed the store with initial data (no-op for in-memory).
   * @returns Promise that resolves when seeding is complete.
   */
  async seed() {
    await sleep();
  }

  /**
   * Drop all data from the store.
   * @returns Promise that resolves when the store is cleared.
   */
  async drop() {
    await sleep();
    this._events.length = 0;
    this._streams = new Map();
  }

  /**
   * Query events in the store, optionally filtered by query options.
   * @param callback - Function to call for each event.
   * @param query - Optional query options.
   * @returns The number of events processed.
   */
  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) {
    await sleep();
    const {
      stream,
      names,
      before,
      after = -1,
      limit,
      created_before,
      created_after,
      correlation,
      with_snaps = false,
    } = query || {};
    let i = after + 1,
      count = 0;
    while (i < this._events.length) {
      const e = this._events[i++];
      if (stream) {
        if (typeof stream === "string") {
          if (e.stream !== stream) continue;
        } else if (!stream.test(e.stream)) continue;
      }
      if (names && !names.includes(e.name)) continue;
      if (correlation && e.meta?.correlation !== correlation) continue;
      if (created_after && e.created <= created_after) continue;
      if (e.name === SNAP_EVENT && !with_snaps) continue;
      if (before && e.id >= before) break;
      if (created_before && e.created >= created_before) break;
      callback(e as Committed<E, keyof E>);
      count++;
      if (limit && count >= limit) break;
    }
    return count;
  }

  /**
   * Commit one or more events to a stream.
   * @param stream - The stream name.
   * @param msgs - The events/messages to commit.
   * @param meta - Event metadata.
   * @param expectedVersion - Optional optimistic concurrency check.
   * @returns The committed events with metadata.
   * @throws ConcurrencyError if expectedVersion does not match.
   */
  async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) {
    await sleep();
    const instance = this._events.filter((e) => e.stream === stream); // ignore state events, this is a production optimization
    if (
      typeof expectedVersion === "number" &&
      instance.length - 1 !== expectedVersion
    )
      throw new ConcurrencyError(
        instance.length - 1,
        msgs as Message<Schemas, keyof Schemas>[],
        expectedVersion
      );

    let version = instance.length;
    return msgs.map(({ name, data }) => {
      const committed: Committed<E, keyof E> = {
        id: this._events.length,
        stream,
        version,
        created: new Date(),
        name,
        data,
        meta,
      };
      this._events.push(committed as Committed<Schemas, keyof Schemas>);
      version++;
      return committed;
    });
  }

  /**
   * Polls the store for unblocked streams needing processing, ordered by lease watermark ascending.
   * @param limit - Maximum number of streams to poll.
   * @returns The polled streams.
   */
  async poll(limit: number) {
    await sleep();
    return [...this._streams.values()]
      .filter((s) => s.is_avaliable)
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map(({ stream, source, at }) => ({ stream, source, at }));
  }

  /**
   * Lease streams for processing (e.g., for distributed consumers).
   * @param leases - Lease requests.
   * @returns Granted leases.
   */
  async lease(leases: Lease[]) {
    await sleep();
    return leases
      .map((lease) => {
        const stream =
          this._streams.get(lease.stream) ||
          // store new correlations
          this._streams
            .set(lease.stream, new InMemoryStream(lease))
            .get(lease.stream)!;
        return stream.lease(lease, this._leaseMillis);
      })
      .filter((l): l is Lease => !!l);
  }

  /**
   * Acknowledge completion of processing for leased streams.
   * @param leases - Leases to acknowledge.
   */
  async ack(leases: Lease[]) {
    await sleep();
    leases.forEach((lease) => this._streams.get(lease.stream)?.ack(lease));
  }
}
