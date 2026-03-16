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
  private _at = -1;
  private _retry = -1;
  private _blocked = false;
  private _error = "";
  private _leased_by: string | undefined = undefined;
  private _leased_until: Date | undefined = undefined;

  constructor(
    readonly stream: string,
    readonly source: string | undefined
  ) {}

  get is_avaliable() {
    return (
      !this._blocked &&
      (!this._leased_until || this._leased_until <= new Date())
    );
  }

  get at() {
    return this._at;
  }

  /**
   * Attempt to lease this stream for processing.
   * @param lease - The lease request.
   * @param millis - Lease duration in milliseconds.
   * @returns The granted lease or undefined if blocked.
   */
  lease(lease: Lease, millis: number): Lease {
    if (millis > 0) {
      this._leased_by = lease.by;
      this._leased_until = new Date(Date.now() + millis);
    }
    this._retry = this._retry + 1;
    return {
      stream: this.stream,
      source: this.source,
      at: lease.at,
      by: lease.by,
      retry: this._retry,
      lagging: lease.lagging,
    };
  }

  /**
   * Acknowledge completion of processing for this stream.
   * @param lease - The lease request.
   */
  ack(lease: Lease) {
    if (this._leased_by === lease.by) {
      this._leased_by = undefined;
      this._leased_until = undefined;
      this._at = lease.at;
      this._retry = -1;
      return {
        stream: this.stream,
        source: this.source,
        at: this._at,
        by: lease.by,
        retry: this._retry,
        lagging: lease.lagging,
      };
    }
  }

  /**
   * Block a stream for processing after failing to process and reaching max retries with blocking enabled.
   * @param lease - The lease request.
   * @param error Blocked error message.
   */
  block(lease: Lease, error: string) {
    if (this._leased_by === lease.by) {
      this._blocked = true;
      this._error = error;
      return {
        stream: this.stream,
        source: this.source,
        at: this._at,
        by: this._leased_by,
        retry: this._retry,
        error: this._error,
        lagging: lease.lagging,
      };
    }
  }
}

/**
 * In-memory event store implementation.
 *
 * This is the default store used by Act when no other store is injected.
 * It stores all events in memory and is suitable for:
 * - Development and prototyping
 * - Unit and integration testing
 * - Demonstrations and examples
 *
 * **Not suitable for production** - all data is lost when the process exits.
 * Use {@link PostgresStore} for production deployments.
 *
 * The in-memory store provides:
 * - Full {@link Store} interface implementation
 * - Optimistic concurrency control
 * - Stream leasing for distributed processing simulation
 * - Snapshot support
 * - Fast performance (no I/O overhead)
 *
 * @example Using in tests
 * ```typescript
 * import { store } from "@rotorsoft/act";
 *
 * describe("Counter", () => {
 *   beforeEach(async () => {
 *     // Reset store between tests
 *     await store().seed();
 *   });
 *
 *   it("increments", async () => {
 *     await app.do("increment", target, { by: 5 });
 *     const snapshot = await app.load(Counter, "counter-1");
 *     expect(snapshot.state.count).toBe(5);
 *   });
 * });
 * ```
 *
 * @example Explicit instantiation
 * ```typescript
 * import { InMemoryStore } from "@rotorsoft/act";
 *
 * const testStore = new InMemoryStore();
 * await testStore.seed();
 *
 * // Use for specific test scenarios
 * await testStore.commit("test-stream", events, meta);
 * ```
 *
 * @example Querying events
 * ```typescript
 * const events: any[] = [];
 * await store().query(
 *   (event) => events.push(event),
 *   { stream: "test-stream" }
 * );
 * console.log(`Found ${events.length} events`);
 * ```
 *
 * @see {@link Store} for the interface definition
 * @see {@link PostgresStore} for production use
 * @see {@link store} for injecting stores
 *
 * @category Adapters
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

  private in_query<E extends Schemas>(query: Query, e: Committed<E, keyof E>) {
    if (query.stream && !RegExp(`^${query.stream}$`).test(e.stream))
      return false;
    if (query.names && !query.names.includes(e.name as string)) return false;
    if (query.correlation && e.meta?.correlation !== query.correlation)
      return false;
    if (e.name === SNAP_EVENT && !query.with_snaps) return false;
    return true;
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
    let count = 0;
    if (query?.backward) {
      let i = (query?.before || this._events.length) - 1;
      while (i >= 0) {
        const e = this._events[i--];
        if (query && !this.in_query(query, e)) continue;
        if (query?.created_before && e.created >= query.created_before)
          continue;
        if (query.after && e.id <= query.after) break;
        if (query.created_after && e.created <= query.created_after) break;
        callback(e as Committed<E, keyof E>);
        count++;
        if (query?.limit && count >= query.limit) break;
      }
    } else {
      let i = (query?.after ?? -1) + 1;
      while (i < this._events.length) {
        const e = this._events[i++];
        if (query && !this.in_query(query, e)) continue;
        if (query?.created_after && e.created <= query.created_after) continue;
        if (query?.before && e.id >= query.before) break;
        if (query?.created_before && e.created >= query.created_before) break;
        callback(e as Committed<E, keyof E>);
        count++;
        if (query?.limit && count >= query.limit) break;
      }
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
   * Atomically discovers and leases streams for processing.
   * Fuses poll + lease into a single operation.
   * @param lagging - Max streams from lagging frontier.
   * @param leading - Max streams from leading frontier.
   * @param by - Lease holder identifier.
   * @param millis - Lease duration in milliseconds.
   * @returns Granted leases.
   */
  async claim(lagging: number, leading: number, by: string, millis: number) {
    await sleep();
    const available = [...this._streams.values()].filter(
      (s) =>
        s.is_avaliable &&
        (s.at < 0 ||
          this._events.some(
            (e) =>
              e.id > s.at &&
              e.name !== SNAP_EVENT &&
              (!s.source || RegExp(s.source).test(e.stream))
          ))
    );
    const lag = available
      .sort((a, b) => a.at - b.at)
      .slice(0, lagging)
      .map((s) => ({
        stream: s.stream,
        source: s.source,
        at: s.at,
        lagging: true,
      }));
    const lead = available
      .sort((a, b) => b.at - a.at)
      .slice(0, leading)
      .map((s) => ({
        stream: s.stream,
        source: s.source,
        at: s.at,
        lagging: false,
      }));
    // deduplicate (a stream can appear in both frontiers)
    const seen = new Set<string>();
    const combined = [...lag, ...lead].filter((p) => {
      if (seen.has(p.stream)) return false;
      seen.add(p.stream);
      return true;
    });
    // lease each atomically
    return combined
      .map((p) =>
        this._streams.get(p.stream)?.lease({ ...p, by, retry: 0 }, millis)
      )
      .filter((l) => !!l);
  }

  /**
   * Registers streams for event processing.
   * @param streams - Streams to register with optional source.
   * @returns subscribed count and current max watermark.
   */
  async subscribe(streams: Array<{ stream: string; source?: string }>) {
    await sleep();
    let subscribed = 0;
    for (const { stream, source } of streams) {
      if (!this._streams.has(stream)) {
        this._streams.set(stream, new InMemoryStream(stream, source));
        subscribed++;
      }
    }
    let watermark = -1;
    for (const s of this._streams.values()) {
      if (s.at > watermark) watermark = s.at;
    }
    return { subscribed, watermark };
  }

  /**
   * Acknowledge completion of processing for leased streams.
   * @param leases - Leases to acknowledge, including last processed watermark and lease holder.
   */
  async ack(leases: Lease[]) {
    await sleep();
    return leases
      .map((l) => this._streams.get(l.stream)?.ack(l))
      .filter((l) => !!l);
  }

  /**
   * Block a stream for processing after failing to process and reaching max retries with blocking enabled.
   * @param leases - Leases to block, including lease holder and last error message.
   * @returns Blocked leases.
   */
  async block(leases: Array<Lease & { error: string }>) {
    await sleep();
    return leases
      .map((l) => this._streams.get(l.stream)?.block(l, l.error))
      .filter((l) => !!l);
  }
}
