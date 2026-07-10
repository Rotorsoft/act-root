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
import { DEFAULT_LANE, SNAP_EVENT, TOMBSTONE_EVENT } from "../ports.js";
import { ConcurrencyError } from "../types/errors.js";
import type {
  BlockedLease,
  Committed,
  EventMeta,
  Lease,
  Message,
  Query,
  QueryStatsOptions,
  QueryStreams,
  QueryStreamsResult,
  Schema,
  Schemas,
  Store,
  StreamFilter,
  StreamPosition,
  StreamStats,
} from "../types/index.js";
import { sleep } from "../utils.js";

/**
 * @internal
 * Represents an in-memory stream for event processing and leasing.
 */
class InMemoryStream {
  readonly stream: string;
  readonly source: string | undefined;
  private _at = -1;
  private _retry = -1;
  private _blocked = false;
  private _error = "";
  private _leased_by: string | undefined = undefined;
  private _leased_until: Date | undefined = undefined;
  private _priority = 0;
  private _lane: string = DEFAULT_LANE;
  // Persisted next-visit time (#1090). When set and still in the future, the
  // stream is held out of `claim` entirely — so a deferred reaction is not
  // re-claimed (and `retry` is never bumped) until its due-time passes. Unlike
  // in-process backoff, this is durable store state shared across workers.
  private _deferred_at: number | undefined = undefined;

  constructor(
    stream: string,
    source: string | undefined,
    priority = 0,
    lane: string = DEFAULT_LANE
  ) {
    this.stream = stream;
    this.source = source;
    this._priority = priority;
    this._lane = lane;
  }

  get priority() {
    return this._priority;
  }

  get lane() {
    return this._lane;
  }

  /** Replace on every subscribe — current builder config wins on restart. */
  set lane(value: string) {
    this._lane = value;
  }

  /**
   * Bump the priority via {@link subscribe}: keeps the maximum across
   * reactions so the highest-priority registrant wins.
   */
  bump_priority(priority: number) {
    if (priority > this._priority) this._priority = priority;
  }

  /**
   * Set the priority outright via {@link prioritize}: operator
   * runtime override that ignores the build-time `max()` invariant.
   */
  set_priority(priority: number) {
    this._priority = priority;
  }

  get is_available() {
    return (
      !this._blocked &&
      (!this._leased_until || this._leased_until <= new Date()) &&
      // A stream deferred to a future time is not claimable until due (#1090).
      (!this._deferred_at || this._deferred_at <= Date.now())
    );
  }

  /**
   * Hold this stream out of `claim` until `deferred_at` (ms since epoch).
   * Set by a deliberate `defer` outcome — not a failure, so retry/blocked
   * state is untouched. Cleared by ack/block/reset/unblock.
   */
  defer(deferred_at: number) {
    this._deferred_at = deferred_at;
    // A defer is not a failure: reset retry so the redelivery after the
    // due-time is a fresh attempt, never accumulating toward maxRetries.
    this._retry = -1;
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
      lane: this._lane,
    };
  }

  /**
   * Finalize this stream's lease: ack (advance the watermark) or, when the
   * lease carries a `due` marker, defer (persist the schedule, hold the
   * watermark) — see {@link Store.ack}.
   * @param lease - The lease request.
   */
  ack(lease: Lease) {
    if (this._leased_by === lease.by) {
      this._leased_by = undefined;
      this._leased_until = undefined;
      this._retry = -1;
      if (lease.due !== undefined) {
        // Defer marker: schedule the re-visit, keep the watermark.
        // Deferred entries are not part of ack's return value.
        this._deferred_at = lease.due;
        return undefined;
      }
      this._at = lease.at;
      // Advancing the watermark ends any active defer schedule.
      this._deferred_at = undefined;
      return {
        stream: this.stream,
        source: this.source,
        at: this._at,
        by: lease.by,
        retry: this._retry,
        lagging: lease.lagging,
        lane: this._lane,
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
      // A blocked stream is poison; clear any pending defer (#1090).
      this._deferred_at = undefined;
      return {
        stream: this.stream,
        source: this.source,
        at: this._at,
        by: this._leased_by,
        retry: this._retry,
        error: this._error,
        lagging: lease.lagging,
        lane: this._lane,
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
    this._deferred_at = undefined;
  }

  /**
   * Clear the blocked flag and lease bookkeeping without touching the
   * watermark. Returns true if the stream was actually blocked (and is
   * now flipped); false otherwise.
   */
  unblock(): boolean {
    if (!this._blocked) return false;
    this._blocked = false;
    this._retry = -1;
    this._error = "";
    this._leased_by = undefined;
    this._leased_until = undefined;
    this._deferred_at = undefined;
    return true;
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
  // next event id — monotonic, never reused. Deletions (truncate, windowed
  // prune) punch holes in the id sequence, so ids are NOT array indexes and
  // NOT `_events.length`; they only stay sorted ascending in `_events`.
  private _next_id = 0;
  // stored stream positions and other metadata
  private _streams: Map<string, InMemoryStream> = new Map();
  // last committed version per stream — O(1) replacement for filter-on-commit
  private _stream_versions: Map<string, number> = new Map();
  // max non-snapshot event id per stream — drives the exact-source probe in claim()
  // without scanning the full event log.
  private _max_event_id_by_stream: Map<string, number> = new Map();
  // global max non-snapshot event id — fast pre-check for source-less streams in claim()
  private _max_non_snap_event_id = -1;
  // stream → (event_id → cloned sensitive payload). Two-level so `forget_pii`
  // is O(1) — drop the inner Map for the stream and the wipe is done — mirroring
  // the `DELETE WHERE stream = ?` scope that durable adapters get from their
  // stream index. Entries exist only for events committed with a non-null
  // `pii` field; absence means "no PII" (returned as `null` on load).
  private _pii: Map<string, Map<number, Record<string, unknown>>> = new Map();

  private _reset_indexes() {
    this._events.length = 0;
    this._next_id = 0;
    this._stream_versions.clear();
    this._max_event_id_by_stream.clear();
    this._max_non_snap_event_id = -1;
    this._pii.clear();
  }

  // First index whose event id is greater than `after`. `_events` stays
  // sorted ascending by id (append-only commits; deletions preserve
  // order), so id-bounded scans binary-search their start instead of
  // assuming id === index — an invariant that truncation breaks.
  private _first_index_after(after: number): number {
    let lo = 0;
    let hi = this._events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._events[mid].id > after) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Attach the isolated PII payload (or null) to an event before handing it to
  // a caller. Allocation-free for events without PII — by far the common case.
  private _with_pii<E extends Schemas>(
    e: Committed<E, keyof E>
  ): Committed<E, keyof E> {
    const pii = this._pii.get(e.stream)?.get(e.id);
    return pii ? ({ ...e, pii } as Committed<E, keyof E>) : e;
  }

  /**
   * Dispose of the store and clear all events.
   * @returns Promise that resolves when disposal is complete.
   */
  async dispose() {
    await sleep();
    this._reset_indexes();
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
    this._reset_indexes();
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
      let i =
        (query?.before !== undefined
          ? this._first_index_after(query.before - 1)
          : this._events.length) - 1;
      while (i >= 0) {
        const e = this._events[i--];
        if (query && !this.in_query(query, e)) continue;
        if (query?.created_before && e.created >= query.created_before)
          continue;
        if (query.after && e.id <= query.after) break;
        if (query.created_after && e.created <= query.created_after) break;
        await Promise.resolve(
          callback(this._with_pii(e as Committed<E, keyof E>))
        );
        count++;
        if (query?.limit && count >= query.limit) break;
      }
    } else {
      let i = this._first_index_after(query?.after ?? -1);
      // with_snaps resumes at the latest snapshot for an exact single
      // stream (no explicit `after`): start the scan at that snapshot's
      // position so pre-snapshot events aren't read. No snapshot → full
      // scan; an explicit `after` wins.
      if (
        query?.with_snaps &&
        query.stream_exact &&
        query.stream !== undefined &&
        query.after === undefined
      ) {
        for (let j = this._events.length - 1; j >= 0; j--) {
          const e = this._events[j];
          if (e.stream === query.stream && e.name === SNAP_EVENT) {
            i = j;
            break;
          }
        }
      }
      while (i < this._events.length) {
        const e = this._events[i++];
        if (query && !this.in_query(query, e)) continue;
        if (query?.created_after && e.created <= query.created_after) continue;
        if (query?.before && e.id >= query.before) break;
        if (query?.created_before && e.created >= query.created_before) break;
        await Promise.resolve(
          callback(this._with_pii(e as Committed<E, keyof E>))
        );
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
    const current_version = this._stream_versions.get(stream) ?? -1;
    if (
      typeof expectedVersion === "number" &&
      current_version !== expectedVersion
    ) {
      throw new ConcurrencyError(
        stream,
        current_version,
        msgs as Message<Schemas, keyof Schemas>[],
        expectedVersion
      );
    }

    let version = current_version + 1;
    let last_non_snap_id = -1;
    const committed = msgs.map(({ name, data, pii }) => {
      const c: Committed<E, keyof E> = {
        id: this._next_id++,
        stream,
        version,
        created: new Date(),
        name,
        data,
        meta,
      };
      // The stored event is the pii-less view — `forget_pii` only has to
      // drop the inner Map for the stream, never the event row. Mandatory
      // clone on the pii payload defends against caller-side mutation.
      this._events.push(c as Committed<Schemas, keyof Schemas>);
      if (pii != null) {
        let per_stream = this._pii.get(stream);
        if (!per_stream) {
          per_stream = new Map();
          this._pii.set(stream, per_stream);
        }
        per_stream.set(c.id, structuredClone(pii) as Record<string, unknown>);
      }
      if (name !== SNAP_EVENT) last_non_snap_id = c.id;
      version++;
      return this._with_pii(c);
    });
    this._stream_versions.set(stream, version - 1);
    if (last_non_snap_id >= 0) {
      this._max_event_id_by_stream.set(stream, last_non_snap_id);
      // commit always assigns a fresh id from the monotonic _next_id, so
      // any non-snap commit strictly raises the global max.
      this._max_non_snap_event_id = last_non_snap_id;
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
  async claim(
    lagging: number,
    leading: number,
    by: string,
    millis: number,
    lane?: string
  ) {
    await sleep();
    // `source` is an exact stream name in the has-work probe — resolvers
    // hand `subscribe` exact names, so the probe is a single map lookup.
    // Pattern matching belongs to the StreamFilter surfaces
    // (`query_streams`, `reset`, `unblock`), never to claim.
    const has_work = (s: InMemoryStream): boolean => {
      if (s.at < 0) return true;
      if (!s.source) return s.at < this._max_non_snap_event_id;
      const max_id = this._max_event_id_by_stream.get(s.source);
      return max_id !== undefined && max_id > s.at;
    };
    const available = [...this._streams.values()].filter(
      (s) =>
        s.is_available && has_work(s) && (lane === undefined || s.lane === lane)
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
    streams: Array<{
      stream: string;
      source?: string;
      priority?: number;
      lane?: string;
    }>
  ) {
    await sleep();
    let subscribed = 0;
    for (const {
      stream,
      source,
      priority = 0,
      lane = DEFAULT_LANE,
    } of streams) {
      const existing = this._streams.get(stream);
      if (existing) {
        existing.bump_priority(priority);
        existing.lane = lane;
      } else {
        this._streams.set(
          stream,
          new InMemoryStream(stream, source, priority, lane)
        );
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
    // Acks and defer schedules land in one synchronous pass — the
    // in-memory equivalent of the single-transaction contract on
    // {@link Store.ack}: no await between entries, so a caller
    // never observes a cycle's acks without its schedules. `due`-carrying
    // entries defer (and return undefined), the rest ack.
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
   * Hold the matched streams out of {@link claim} until `deferred_at`
   * (ms since epoch) — see {@link Store.defer}. Accepts an explicit list
   * of names or a {@link StreamFilter}, mirroring {@link reset}/{@link unblock}.
   * Persisted store state (unlike in-process backoff), so the skip is honored
   * by every competing worker. Unknown names are silently skipped.
   *
   * @returns Count of streams whose `deferred_at` was set.
   */
  async defer(input: string[] | StreamFilter, deferred_at: number) {
    await sleep();
    let count = 0;
    if (Array.isArray(input)) {
      for (const name of input) {
        const s = this._streams.get(name);
        if (s) {
          s.defer(deferred_at);
          count++;
        }
      }
    } else {
      const matches = this._filter_predicate(input);
      for (const s of this._streams.values()) {
        if (matches(s)) {
          s.defer(deferred_at);
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Build a predicate from a {@link StreamFilter}. Compiled regexes are
   * cached in the closure so callers can apply it across the streams
   * map without re-compiling per iteration.
   */
  private _filter_predicate(
    filter: StreamFilter
  ): (s: InMemoryStream) => boolean {
    const stream_re =
      filter.stream && !filter.stream_exact
        ? new RegExp(filter.stream)
        : undefined;
    const source_re =
      filter.source && !filter.source_exact
        ? new RegExp(filter.source)
        : undefined;
    return (s) => {
      if (filter.stream !== undefined) {
        if (
          filter.stream_exact
            ? s.stream !== filter.stream
            : !stream_re!.test(s.stream)
        )
          return false;
      }
      if (filter.source !== undefined) {
        if (s.source === undefined) return false;
        if (
          filter.source_exact
            ? s.source !== filter.source
            : !source_re!.test(s.source)
        )
          return false;
      }
      if (filter.blocked !== undefined && s.blocked !== filter.blocked)
        return false;
      if (filter.lane !== undefined && s.lane !== filter.lane) return false;
      return true;
    };
  }

  /**
   * Reset watermarks to -1, clearing retry, blocked, error, and lease
   * state so the matched streams can be replayed from the beginning.
   * Accepts either an explicit list of names or a {@link StreamFilter}.
   *
   * @param input - Stream names or a filter selecting the streams to reset.
   * @returns Count of streams that were actually reset.
   */
  async reset(input: string[] | StreamFilter) {
    await sleep();
    let count = 0;
    if (Array.isArray(input)) {
      for (const name of input) {
        const s = this._streams.get(name);
        if (s) {
          s.reset();
          count++;
        }
      }
    } else {
      const matches = this._filter_predicate(input);
      for (const s of this._streams.values()) {
        if (matches(s)) {
          s.reset();
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Clear the blocked flag (and retry / error / lease) on the matched
   * streams without touching the watermark. Streams that aren't blocked
   * at call time are silently skipped. Accepts either an explicit list
   * of names or a {@link StreamFilter}. The filter form always restricts
   * to blocked streams — passing `blocked: false` matches nothing.
   * See {@link Store.unblock}.
   *
   * @param input - Stream names or a filter selecting the streams to unblock.
   * @returns Count of streams that were actually flipped (were blocked).
   */
  /**
   * Wipe the sensitive-data payload for every event on the stream — see
   * {@link Store.forget_pii}. O(1) drop of the stream's inner Map; the size of
   * that Map is the count of events that had PII. Idempotent: a second call
   * finds no inner Map and returns `0`.
   *
   * @param stream - Target stream.
   * @returns Count of events whose isolated PII payload was deleted.
   */
  async forget_pii(stream: string): Promise<number> {
    await sleep();
    const count = this._pii.get(stream)?.size ?? 0;
    this._pii.delete(stream);
    return count;
  }

  async unblock(input: string[] | StreamFilter) {
    await sleep();
    let count = 0;
    if (Array.isArray(input)) {
      for (const name of input) {
        const s = this._streams.get(name);
        if (s?.unblock()) count++;
      }
    } else {
      // Filter form: always restrict to blocked streams. An explicit
      // `blocked: false` in the filter is silently overridden — there
      // is no use case for "unblock unblocked streams."
      const matches = this._filter_predicate({ ...input, blocked: true });
      for (const s of this._streams.values()) {
        if (matches(s) && s.unblock()) count++;
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
  async prioritize(filter: StreamFilter, priority: number) {
    await sleep();
    const matches = this._filter_predicate(filter);
    let count = 0;
    for (const s of this._streams.values()) {
      if (!matches(s)) continue;
      if (s.priority !== priority) {
        s.set_priority(priority);
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
    const source_matches = query?.source_matches;
    const stream_re =
      query?.stream && !query.stream_exact
        ? new RegExp(query.stream)
        : undefined;
    const source_re =
      query?.source && !query.source_exact
        ? new RegExp(query.source)
        : undefined;
    // Reverse-match: a stream qualifies when its stored `source` pattern
    // matches at least one of the requested names. Patterns are compiled
    // once and cached — many subscriptions share one source pattern.
    const reverse_cache = new Map<string, RegExp>();
    const reverse_match = (source: string): boolean => {
      let re = reverse_cache.get(source);
      if (!re) {
        re = new RegExp(source);
        reverse_cache.set(source, re);
      }
      return source_matches!.some((name) => re!.test(name));
    };

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
            : !stream_re!.test(s.stream)
        )
          continue;
      }
      if (query?.source !== undefined) {
        if (s.source === undefined) continue;
        if (
          query.source_exact
            ? s.source !== query.source
            : !source_re!.test(s.source)
        )
          continue;
      }
      if (source_matches !== undefined) {
        // Absent/empty source = no source constraint = consumes from
        // every stream, so it matches any requested name. Only a
        // present source that matches none of them is excluded.
        if (s.source && !reverse_match(s.source)) continue;
      }
      if (blocked !== undefined && s.blocked !== blocked) continue;
      if (query?.lane !== undefined && s.lane !== query.lane) continue;
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
        lane: s.lane,
      });
      count++;
      if (count >= limit) break;
    }
    return { maxEventId: this._events.at(-1)?.id ?? -1, count };
  }

  /**
   * Per-stream aggregated stats — see {@link Store.query_stats}.
   *
   * Single forward scan over the in-memory event list, accumulating per
   * stream. The "cheap heads" cost tier from durable adapters doesn't
   * apply here (InMemory has no indexes); correctness is the goal, perf
   * is a non-issue.
   *
   * Scope rules:
   * - Array `input` — explicit stream names, regardless of subscription.
   * - Filter `input` — `stream`/`stream_exact` match against event-bearing
   *   stream names; `source`/`source_exact`/`blocked` require a
   *   corresponding subscription in `_streams` (those are subscription
   *   concepts, not event concepts). Empty filter `{}` matches every
   *   event-bearing stream.
   */
  async query_stats<E extends Schemas>(
    input: string[] | Pick<StreamFilter, "stream" | "stream_exact">,
    options?: QueryStatsOptions<E>
  ): Promise<Map<string, StreamStats<E>>> {
    await sleep();
    const exclude = new Set<string>(options?.exclude ?? []);
    const want_tail = options?.tail ?? false;
    const want_count = options?.count ?? false;
    const want_names = options?.names ?? false;
    const before = options?.before;
    const after = options?.after;
    const limit = options?.limit;

    // Pre-compile per-stream scope predicate, cached as we go so each
    // distinct stream evaluates the regex once.
    const array_targets = Array.isArray(input) ? new Set(input) : null;
    const filter = Array.isArray(input) ? null : input;
    const stream_re =
      filter?.stream && !filter.stream_exact
        ? new RegExp(filter.stream)
        : undefined;

    const scope_cache = new Map<string, boolean>();
    const in_scope = (stream: string): boolean => {
      const cached = scope_cache.get(stream);
      if (cached !== undefined) return cached;
      let ok = true;
      if (array_targets) {
        ok = array_targets.has(stream);
      } else if (filter?.stream !== undefined) {
        ok = filter.stream_exact
          ? stream === filter.stream
          : // stream_re set when stream is regex
            stream_re!.test(stream);
      }
      scope_cache.set(stream, ok);
      return ok;
    };

    type Acc = {
      head: Committed<Schemas, keyof Schemas>;
      tail?: Committed<Schemas, keyof Schemas>;
      count: number;
      names?: Record<string, number>;
    };
    const acc = new Map<string, Acc>();
    for (const e of this._events) {
      if (before !== undefined && e.id >= before) continue;
      if (!in_scope(e.stream)) continue;
      if (exclude.has(e.name as string)) continue;
      let a = acc.get(e.stream);
      if (!a) {
        a = { head: e, count: 0 };
        if (want_tail) a.tail = e;
        if (want_names) a.names = {};
        acc.set(e.stream, a);
      }
      a.head = e;
      a.count++;
      if (want_names) {
        const n = String(e.name);
        // a.names initialized above when want_names
        a.names![n] = (a.names![n] ?? 0) + 1;
      }
    }

    // Order by stream name so `after`/`limit` keyset-paginate
    // deterministically (matches query_streams ordering).
    const ordered = [...acc.keys()].sort((x, y) => x.localeCompare(y));
    const out = new Map<string, StreamStats<E>>();
    for (const stream of ordered) {
      if (after !== undefined && stream <= after) continue;
      const a = acc.get(stream)!;
      const stats: {
        head: Committed<Schemas, keyof Schemas>;
        tail?: Committed<Schemas, keyof Schemas>;
        count?: number;
        names?: Record<string, number>;
      } = { head: a.head };
      if (want_tail) stats.tail = a.tail;
      if (want_count) stats.count = a.count;
      if (want_names) stats.names = a.names;
      out.set(stream, stats as StreamStats<E>);
      if (limit !== undefined && out.size >= limit) break;
    }
    return out;
  }

  /**
   * Atomically truncates streams and seeds each with a snapshot or tombstone.
   * Windowed targets (`before` set) prune the prefix below the closest safe
   * `__snapshot__` instead — no seed, subscriptions untouched, no-op when no
   * snapshot qualifies.
   * @param targets - Streams to truncate with optional snapshot state and meta,
   *   or a `before`/`max_id` boundary for a windowed prefix delete.
   * @returns Map keyed by stream name, each entry with `deleted` count and `committed` event.
   */
  async truncate(
    targets: Array<{
      stream: string;
      snapshot?: Schema;
      meta?: EventMeta;
      before?: Date;
      max_id?: number;
    }>
  ) {
    await sleep();
    const result = new Map<
      string,
      {
        deleted: number;
        committed: Committed<Schemas, keyof Schemas>;
        before?: Date;
      }
    >();

    // Windowed targets: pure prefix delete behind the closest safe snapshot.
    const windowed = targets.filter((t) => t.before !== undefined);
    if (windowed.length) {
      const drop = new Set<number>();
      for (const { stream, before, max_id } of windowed) {
        let boundary: Committed<Schemas, keyof Schemas> | undefined;
        for (const e of this._events) {
          if (
            e.stream === stream &&
            e.name === SNAP_EVENT &&
            e.created < before! &&
            (max_id === undefined || e.id <= max_id) &&
            (!boundary || e.id > boundary.id)
          )
            boundary = e;
        }
        if (!boundary) continue; // no qualifying snapshot → no-op
        let deleted = 0;
        for (const e of this._events) {
          if (e.stream === stream && e.id < boundary.id) {
            drop.add(e.id);
            this._pii.get(stream)?.delete(e.id);
            deleted++;
          }
        }
        result.set(stream, { deleted, committed: boundary, before });
      }
      if (drop.size) this._events = this._events.filter((e) => !drop.has(e.id));
    }

    const full = targets.filter((t) => t.before === undefined);
    // Count per-stream deletions
    const deleted_counts = new Map<string, number>();
    const stream_set = new Set(full.map((t) => t.stream));
    for (const e of this._events) {
      if (stream_set.has(e.stream)) {
        deleted_counts.set(e.stream, (deleted_counts.get(e.stream) ?? 0) + 1);
      }
    }
    this._events = this._events.filter((e) => !stream_set.has(e.stream));
    for (const stream of stream_set) {
      this._streams.delete(stream);
      this._stream_versions.delete(stream);
      this._max_event_id_by_stream.delete(stream);
      // The pii payloads die with the event rows, matching the durable
      // adapters' `DELETE WHERE stream = ?` scope.
      this._pii.delete(stream);
    }
    for (const { stream, snapshot, meta } of full) {
      const event: Committed<Schemas, keyof Schemas> = {
        id: this._next_id++,
        stream,
        version: 0,
        created: new Date(),
        name: snapshot !== undefined ? SNAP_EVENT : TOMBSTONE_EVENT,
        data: snapshot ?? {},
        meta: meta ?? { correlation: "", causation: {} },
      };
      this._events.push(event);
      this._stream_versions.set(stream, 0);
      if (event.name !== SNAP_EVENT) {
        this._max_event_id_by_stream.set(stream, event.id);
      }
      result.set(stream, {
        deleted: deleted_counts.get(stream) ?? 0,
        committed: event,
      });
    }
    // Recompute global max from the per-stream index — deletions may have
    // dropped the previous max, while new tombstones may have raised it.
    let max = -1;
    for (const id of this._max_event_id_by_stream.values())
      if (id > max) max = id;
    this._max_non_snap_event_id = max;
    return result;
  }

  /**
   * Atomically wipe-and-rebuild the store under an in-process snapshot.
   *
   * Captures every index state up front, clears it, then hands the
   * orchestrator a per-event insert `callback` via the driver. Any
   * throw inside the driver restores the snapshot, leaving the store
   * byte-for-byte unchanged from the operator's perspective.
   *
   * `id`s are reassigned `0..N-1` as events arrive (dense — the
   * monotonic id counter restarts at 0 for the rebuild). `created` is
   * preserved verbatim from the source.
   */
  async restore(
    driver: (
      callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
    ) => Promise<void>
  ): Promise<void> {
    await sleep();
    // Snapshot every index so we can roll back on throw.
    const prev_events = this._events;
    const prev_next_id = this._next_id;
    const prev_streams = this._streams;
    const prev_stream_versions = this._stream_versions;
    const prev_max_event_id_by_stream = this._max_event_id_by_stream;
    const prev_max_non_snap_event_id = this._max_non_snap_event_id;
    // Swap in fresh state for the duration of the rebuild.
    this._events = [];
    this._next_id = 0;
    this._streams = new Map();
    this._stream_versions = new Map();
    this._max_event_id_by_stream = new Map();
    this._max_non_snap_event_id = -1;
    try {
      await driver(async (event) => {
        const id = this._next_id++;
        const committed: Committed<Schemas, keyof Schemas> = { ...event, id };
        this._events.push(committed);
        // Last event per stream wins for the version watermark — the
        // source is expected to be in commit order, so this is also
        // the highest version. Out-of-order sources get last-wins,
        // matching the legacy raw-SQL restore.
        this._stream_versions.set(event.stream, event.version);
        if (event.name !== SNAP_EVENT) {
          this._max_event_id_by_stream.set(event.stream, id);
          this._max_non_snap_event_id = id;
        }
        return id;
      });
    } catch (err) {
      // Roll back to the captured snapshot — every index restored
      // exactly as it was before the call started.
      this._events = prev_events;
      this._next_id = prev_next_id;
      this._streams = prev_streams;
      this._stream_versions = prev_stream_versions;
      this._max_event_id_by_stream = prev_max_event_id_by_stream;
      this._max_non_snap_event_id = prev_max_non_snap_event_id;
      throw err;
    }
  }
}
