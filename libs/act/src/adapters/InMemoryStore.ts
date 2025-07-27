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
  Store,
} from "../types/index.js";
import { sleep } from "../utils.js";

/**
 * @internal
 * Represents an in-memory stream for event processing and leasing.
 */
class InMemoryStream {
  stream: string;
  source: string | undefined;
  at = -1;
  retry = -1;
  blocked = false;
  error = "";
  leased_at: number | undefined = undefined;
  leased_by: string | undefined = undefined;
  leased_until: Date | undefined = undefined;

  constructor(stream: string, source: string | undefined) {
    this.stream = stream;
    this.source = source;
  }

  get is_avaliable() {
    return (
      !this.blocked && (!this.leased_until || this.leased_until <= new Date())
    );
  }

  /**
   * Attempt to lease this stream for processing.
   * @param at - The end-of-lease watermark.
   * @param by - The lease holder.
   * @param millis - Lease duration in milliseconds.
   * @returns The granted lease or undefined if blocked.
   */
  lease(at: number, by: string, millis: number): Lease | undefined {
    if (this.is_avaliable && at > this.at) {
      this.leased_at = at;
      this.leased_by = by;
      this.leased_until = new Date(Date.now() + millis);
      millis > 0 && (this.retry = this.retry + 1);
      return {
        stream: this.stream,
        source: this.source,
        at,
        by,
        retry: this.retry,
      };
    }
  }

  /**
   * Acknowledge completion of processing for this stream.
   * @param at - Last processed watermark.
   * @param by - Lease holder that processed the watermark.
   */
  ack(at: number, by: string) {
    if (this.leased_by === by && at >= this.at) {
      this.leased_at = undefined;
      this.leased_by = undefined;
      this.leased_until = undefined;
      this.at = at;
      this.retry = -1;
      return true;
    }
    return false;
  }

  /**
   * Block a stream for processing after failing to process and reaching max retries with blocking enabled.
   * @param error Blocked error message.
   */
  block(by: string, error: string) {
    if (this.leased_by === by) {
      this.blocked = true;
      this.error = error;
      return true;
    }
    return false;
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
      if (stream && !RegExp(`^${stream}$`).test(e.stream)) continue;
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
    ) {
      throw new ConcurrencyError(
        stream,
        instance.length - 1,
        msgs as Message<Schemas, keyof Schemas>[],
        expectedVersion
      );
    }

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
   * @param descending - Whether to poll streams in descending order (aka poll the most advanced first).
   * @returns The polled streams.
   */
  async poll(limit: number, descending = false) {
    await sleep();
    return [...this._streams.values()]
      .filter((s) => s.is_avaliable)
      .sort((a, b) => (descending ? b.at - a.at : a.at - b.at))
      .slice(0, limit)
      .map(({ stream, source, at }) => ({ stream, source, at }));
  }

  /**
   * Lease streams for processing (e.g., for distributed consumers).
   * @param leases - Lease requests for streams, including end-of-lease watermark, lease holder, and source stream.
   * @param leaseMilis - Lease duration in milliseconds.
   * @returns Granted leases.
   */
  async lease(leases: Lease[], millis: number) {
    await sleep();
    return leases
      .map(({ stream, at, by, source }) => {
        const found =
          this._streams.get(stream) ||
          // store new correlations
          this._streams
            .set(stream, new InMemoryStream(stream, source))
            .get(stream)!;
        return found.lease(at, by, millis);
      })
      .filter((l) => !!l);
  }

  /**
   * Acknowledge completion of processing for leased streams.
   * @param leases - Leases to acknowledge, including last processed watermark and lease holder.
   */
  async ack(leases: Lease[]) {
    await sleep();
    return leases.filter((lease) =>
      this._streams.get(lease.stream)?.ack(lease.at, lease.by)
    );
  }

  /**
   * Block a stream for processing after failing to process and reaching max retries with blocking enabled.
   * @param leases - Leases to block, including lease holder and last error message.
   * @returns Blocked leases.
   */
  async block(leases: Array<Lease & { error: string }>) {
    await sleep();
    return leases.filter((lease) =>
      this._streams.get(lease.stream)?.block(lease.by, lease.error)
    );
  }
}
