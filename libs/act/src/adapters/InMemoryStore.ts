/**
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
  Store,
} from "../types/index.js";
import { sleep } from "../utils.js";

class InMemoryStream {
  _at = -1;
  _retry = -1;
  _lease: Lease | undefined;
  _blocked = false;

  constructor(public readonly stream: string) {}

  /**
   * Attempt to lease this stream for processing.
   * @param lease - Lease request.
   * @returns The granted lease or undefined if blocked.
   */
  lease(lease: Lease): Lease | undefined {
    if (!this._blocked && lease.at > this._at) {
      this._lease = { ...lease, retry: this._retry + 1 };
      return this._lease;
    }
  }

  /**
   * Acknowledge completion of processing for this stream.
   * @param lease - Lease to acknowledge.
   */
  ack(lease: Lease) {
    if (this._lease && lease.at >= this._at) {
      this._retry = lease.retry;
      this._blocked = lease.block;
      if (!this._blocked && !lease.error) {
        this._at = lease.at;
        this._retry = 0;
      }
      this._lease = undefined;
    }
  }
}

/**
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

  /**
   * Dispose of the store and clear all events.
   */
  async dispose() {
    await sleep();
    this._events.length = 0;
  }

  /**
   * Seed the store with initial data (no-op for in-memory).
   */
  async seed() {
    await sleep();
  }

  /**
   * Drop all data from the store.
   */
  async drop() {
    await sleep();
    this._events.length = 0;
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
    } = query || {};
    let i = after + 1,
      count = 0;
    while (i < this._events.length) {
      const e = this._events[i++];
      if (stream && e.stream !== stream) continue;
      if (names && !names.includes(e.name)) continue;
      if (correlation && e.meta?.correlation !== correlation) continue;
      if (created_after && e.created <= created_after) continue;
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
    if (expectedVersion && instance.length - 1 !== expectedVersion)
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
   * Fetches new events from stream watermarks for processing.
   * @param limit - Maximum number of streams to fetch.
   * @returns Fetched streams and events.
   */
  async fetch<E extends Schemas>(limit: number) {
    const streams = [...this._streams.values()]
      .filter((s) => !s._blocked)
      .sort((a, b) => a._at - b._at)
      .slice(0, limit);

    const after = streams.length
      ? streams.reduce(
          (min, s) => Math.min(min, s._at),
          Number.MAX_SAFE_INTEGER
        )
      : -1;

    const events: Committed<E, keyof E>[] = [];
    await this.query<E>((e) => e.name !== SNAP_EVENT && events.push(e), {
      after,
      limit,
    });
    return { streams: streams.map(({ stream }) => stream), events };
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
            .set(lease.stream, new InMemoryStream(lease.stream))
            .get(lease.stream)!;
        return stream.lease(lease);
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
