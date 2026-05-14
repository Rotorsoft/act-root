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
import { SNAP_EVENT, TOMBSTONE_EVENT } from "../ports.js";
import { ConcurrencyError } from "../types/errors.js";
import type {
  BlockedLease,
  Committed,
  EventMeta,
  Lease,
  Message,
  PrioritizeFilter,
  Query,
  QueryStreams,
  QueryStreamsResult,
  Schema,
  Schemas,
  Store,
  StreamPosition,
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
  private _priority = 0;

  constructor(
    readonly stream: string,
    readonly source: string | undefined,
    priority = 0
  ) {
    this._priority = priority;
  }

  get priority() {
    return this._priority;
  }

  /**
   * Bump the priority via {@link subscribe}: keeps the maximum across
   * reactions so the highest-priority registrant wins.
   */
  bumpPriority(priority: number) {
    if (priority > this._priority) this._priority = priority;
  }

  /**
   * Set the priority outright via {@link prioritize}: operator
   * runtime override that ignores the build-time `max()` invariant.
   */
  setPriority(priority: number) {
    this._priority = priority;
  }

  get is_available() {
    return (
      !this._blocked &&
      (!this._leased_until || this._leased_until <= new Date())
    );
  }

  get at() {
    return this._at;
  }

  get retry() {
    return this._retry;
  }

  get blocked() {
    return this._blocked;
  }

  get error() {
    return this._error;
  }

  get leased_by() {
    return this._leased_by;
  }

  get leased_until() {
    return this._leased_until;
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

  /**
   * Reset this stream's watermark and state for replay. The retry counter
   * resets to -1 to match the constructor + ack() invariant ("released
   * stream"); the next claim() bumps it to 0 (first attempt).
   */
  reset() {
    this._at = -1;
    this._retry = -1;
    this._blocked = false;
    this._error = "";
    this._leased_by = undefined;
    this._leased_until = undefined;
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
 * **`Store.notify` is intentionally not implemented.** The notify hook is a
 * cross-process wake-up signal — local commits already arm the drain via
 * `do()`. An in-memory store is single-process by definition, so there is
 * no remote writer to be notified of. The {@link Act} orchestrator
 * detects the absence and falls back to the existing debounce/poll path.
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
  // last committed version per stream — O(1) replacement for filter-on-commit
  private _streamVersions: Map<string, number> = new Map();
  // max non-snapshot event id per stream — drives the source-pattern probe in claim()
  // without scanning the full event log.
  private _maxEventIdByStream: Map<string, number> = new Map();
  // global max non-snapshot event id — fast pre-check for source-less streams in claim()
  private _maxNonSnapEventId = -1;

  private _resetIndexes() {
    this._events.length = 0;
    this._streamVersions.clear();
    this._maxEventIdByStream.clear();
    this._maxNonSnapEventId = -1;
  }

  /**
   * Dispose of the store and clear all events.
   * @returns Promise that resolves when disposal is complete.
   */
  async dispose() {
    await sleep();
    this._resetIndexes();
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
    this._resetIndexes();
    this._streams = new Map();
  }

  private in_query<E extends Schemas>(query: Query, e: Committed<E, keyof E>) {
    if (query.stream) {
      if (query.stream_exact) {
        if (e.stream !== query.stream) return false;
      } else if (!RegExp(query.stream).test(e.stream)) return false;
    }
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
    const currentVersion = this._streamVersions.get(stream) ?? -1;
    if (
      typeof expectedVersion === "number" &&
      currentVersion !== expectedVersion
    ) {
      throw new ConcurrencyError(
        stream,
        currentVersion,
        msgs as Message<Schemas, keyof Schemas>[],
        expectedVersion
      );
    }

    let version = currentVersion + 1;
    let lastNonSnapId = -1;
    const committed = msgs.map(({ name, data }) => {
      const c: Committed<E, keyof E> = {
        id: this._events.length,
        stream,
        version,
        created: new Date(),
        name,
        data,
        meta,
      };
      this._events.push(c as Committed<Schemas, keyof Schemas>);
      if (name !== SNAP_EVENT) lastNonSnapId = c.id;
      version++;
      return c;
    });
    this._streamVersions.set(stream, version - 1);
    if (lastNonSnapId >= 0) {
      this._maxEventIdByStream.set(stream, lastNonSnapId);
      // commit always assigns a fresh id from this._events.length, so any
      // non-snap commit strictly raises the global max.
      this._maxNonSnapEventId = lastNonSnapId;
    }
    return committed;
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
    // Cache compiled regexes — multiple subscribed streams typically share the
    // same source pattern, and the inner loop can run thousands of times per claim.
    const sourceRegex = new Map<string, RegExp>();
    const getRegex = (source: string) => {
      let re = sourceRegex.get(source);
      if (!re) {
        re = new RegExp(source);
        sourceRegex.set(source, re);
      }
      return re;
    };
    const hasWork = (s: InMemoryStream): boolean => {
      if (s.at < 0) return true;
      if (!s.source) return s.at < this._maxNonSnapEventId;
      const re = getRegex(s.source);
      for (const [streamName, maxId] of this._maxEventIdByStream) {
        if (maxId > s.at && re.test(streamName)) return true;
      }
      return false;
    };
    const available = [...this._streams.values()].filter(
      (s) => s.is_available && hasWork(s)
    );
    // Lagging frontier orders by priority DESC (higher first), then by
    // watermark ASC (most-behind first). Mirrors the PG `claim()` SQL
    // — see `libs/act-pg/PERFORMANCE.md` for the benchmark that
    // motivated the priority dimension.
    const lag = available
      .sort((a, b) => b.priority - a.priority || a.at - b.at)
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
   * Registers streams for event processing. When the same stream is
   * resubscribed with a different priority, the **maximum** wins — so
   * the highest-priority registered reaction sets the scheduling lane.
   * Use {@link prioritize} for operator runtime overrides.
   *
   * @param streams - Streams to register with optional source + priority.
   * @returns subscribed count and current max watermark.
   */
  async subscribe(
    streams: Array<{ stream: string; source?: string; priority?: number }>
  ) {
    await sleep();
    let subscribed = 0;
    for (const { stream, source, priority = 0 } of streams) {
      const existing = this._streams.get(stream);
      if (existing) {
        existing.bumpPriority(priority);
      } else {
        this._streams.set(stream, new InMemoryStream(stream, source, priority));
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
  async block(leases: BlockedLease[]) {
    await sleep();
    return leases
      .map((l) => this._streams.get(l.stream)?.block(l, l.error))
      .filter((l) => !!l);
  }

  /**
   * Reset watermarks for the given streams to -1, clearing retry, blocked,
   * error, and lease state so they can be replayed from the beginning.
   * @param streams - Stream names to reset.
   * @returns Count of streams that were actually reset.
   */
  async reset(streams: string[]) {
    await sleep();
    let count = 0;
    for (const name of streams) {
      const s = this._streams.get(name);
      if (s) {
        s.reset();
        count++;
      }
    }
    return count;
  }

  /**
   * Bulk-update priority of streams matching `filter`. Mirrors
   * {@link query_streams}'s filter semantics — see {@link Store.prioritize}.
   * Unlike {@link subscribe} (which keeps `max()` of registered
   * priorities), this sets the priority outright — operator override
   * for the build-time scheduling policy.
   *
   * @returns Count of streams whose priority changed.
   */
  async prioritize(filter: PrioritizeFilter, priority: number) {
    await sleep();
    const streamRe =
      filter.stream && !filter.stream_exact
        ? new RegExp(filter.stream)
        : undefined;
    const sourceRe =
      filter.source && !filter.source_exact
        ? new RegExp(filter.source)
        : undefined;
    let count = 0;
    for (const s of this._streams.values()) {
      if (filter.stream !== undefined) {
        if (
          filter.stream_exact
            ? s.stream !== filter.stream
            : !streamRe!.test(s.stream)
        )
          continue;
      }
      if (filter.source !== undefined) {
        if (s.source === undefined) continue;
        if (
          filter.source_exact
            ? s.source !== filter.source
            : !sourceRe!.test(s.source)
        )
          continue;
      }
      if (filter.blocked !== undefined && s.blocked !== filter.blocked)
        continue;
      if (s.priority !== priority) {
        s.setPriority(priority);
        count++;
      }
    }
    return count;
  }

  /**
   * Streams registered subscription positions to the callback, ordered by
   * stream name. Returns the highest event id in the store and the count
   * of positions emitted.
   */
  async query_streams(
    callback: (position: StreamPosition) => void,
    query?: QueryStreams
  ): Promise<QueryStreamsResult> {
    await sleep();
    const limit = query?.limit ?? 100;
    const after = query?.after;
    const blocked = query?.blocked;
    const streamRe =
      query?.stream && !query.stream_exact
        ? new RegExp(query.stream)
        : undefined;
    const sourceRe =
      query?.source && !query.source_exact
        ? new RegExp(query.source)
        : undefined;

    const sorted = [...this._streams.values()].sort((a, b) =>
      a.stream.localeCompare(b.stream)
    );

    let count = 0;
    for (const s of sorted) {
      if (after !== undefined && s.stream <= after) continue;
      if (query?.stream !== undefined) {
        if (
          query.stream_exact
            ? s.stream !== query.stream
            : !streamRe!.test(s.stream)
        )
          continue;
      }
      if (query?.source !== undefined) {
        if (s.source === undefined) continue;
        if (
          query.source_exact
            ? s.source !== query.source
            : !sourceRe!.test(s.source)
        )
          continue;
      }
      if (blocked !== undefined && s.blocked !== blocked) continue;
      callback({
        stream: s.stream,
        source: s.source,
        at: s.at,
        retry: s.retry,
        blocked: s.blocked,
        error: s.error,
        priority: s.priority,
        leased_by: s.leased_by,
        leased_until: s.leased_until,
      });
      count++;
      if (count >= limit) break;
    }
    return { maxEventId: this._events.length - 1, count };
  }

  /**
   * Atomically truncates streams and seeds each with a snapshot or tombstone.
   * @param targets - Streams to truncate with optional snapshot state and meta.
   * @returns Map keyed by stream name, each entry with `deleted` count and `committed` event.
   */
  async truncate(
    targets: Array<{
      stream: string;
      snapshot?: Schema;
      meta?: EventMeta;
    }>
  ) {
    await sleep();
    // Count per-stream deletions
    const deletedCounts = new Map<string, number>();
    const streamSet = new Set(targets.map((t) => t.stream));
    for (const e of this._events) {
      if (streamSet.has(e.stream)) {
        deletedCounts.set(e.stream, (deletedCounts.get(e.stream) ?? 0) + 1);
      }
    }
    this._events = this._events.filter((e) => !streamSet.has(e.stream));
    for (const stream of streamSet) {
      this._streams.delete(stream);
      this._streamVersions.delete(stream);
      this._maxEventIdByStream.delete(stream);
    }
    const result = new Map<
      string,
      { deleted: number; committed: Committed<Schemas, keyof Schemas> }
    >();
    for (const { stream, snapshot, meta } of targets) {
      const event: Committed<Schemas, keyof Schemas> = {
        id: this._events.length,
        stream,
        version: 0,
        created: new Date(),
        name: snapshot !== undefined ? SNAP_EVENT : TOMBSTONE_EVENT,
        data: snapshot ?? {},
        meta: meta ?? { correlation: "", causation: {} },
      };
      this._events.push(event);
      this._streamVersions.set(stream, 0);
      if (event.name !== SNAP_EVENT) {
        this._maxEventIdByStream.set(stream, event.id);
      }
      result.set(stream, {
        deleted: deletedCounts.get(stream) ?? 0,
        committed: event,
      });
    }
    // Recompute global max from the per-stream index — deletions may have
    // dropped the previous max, while new tombstones may have raised it.
    let max = -1;
    for (const id of this._maxEventIdByStream.values()) if (id > max) max = id;
    this._maxNonSnapEventId = max;
    return result;
  }
}
