/**
 * @packageDocumentation
 * @module act/adapters
 * In-memory event store adapter for development and tests.
 *
 * @category Adapters
 */

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
  SubscribeInput,
} from "../types/index.js";
import { DEFAULT_LANE, SNAP_EVENT, TOMBSTONE_EVENT } from "../types/index.js";
import { sleep } from "../utils.js";

/** One subscription row: watermark, lease, retry and schedule. */
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
  // While in the future, the stream is held out of `claim`.
  private _deferred_at: number | undefined = undefined;
  // Work mark; `undefined` = never correlated, so `claim` skips it.
  private _correlated_at: number | undefined = undefined;

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

  /** Replaced on every subscribe, so the current config wins on restart. */
  set lane(value: string) {
    this._lane = value;
  }

  bump_priority(priority: number) {
    if (priority > this._priority) this._priority = priority;
  }

  get correlated_at() {
    return this._correlated_at;
  }

  /** A mark never regresses, including at zero and negatives. */
  mark(correlated_at: number) {
    if (
      this._correlated_at === undefined ||
      correlated_at > this._correlated_at
    )
      this._correlated_at = correlated_at;
  }

  /** Operator override; ignores the subscribe-time `max()`. */
  set_priority(priority: number) {
    this._priority = priority;
  }

  get is_available() {
    return (
      !this._blocked &&
      (!this._leased_until || this._leased_until <= new Date()) &&
      (!this._deferred_at || this._deferred_at <= Date.now())
    );
  }

  defer(deferred_at: number) {
    this._deferred_at = deferred_at;
    // A defer is not a failure, so the redelivery is a fresh attempt.
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

  get deferred_at() {
    return this._deferred_at;
  }

  lease(lease: Lease, millis: number): Lease {
    // The holder is recorded even at zero `millis`: `ack` is gated on it,
    // so a lease with no holder would drop every ack.
    this._leased_by = lease.by;
    this._leased_until = new Date(Date.now() + millis);
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

  /** Ack, or with `due`, also persist the schedule. See {@link Store.ack}. */
  ack(lease: Lease) {
    if (this._leased_by === lease.by) {
      this._leased_by = undefined;
      this._leased_until = undefined;
      if (lease.due !== undefined) {
        // Advance past the handled prefix and schedule the re-visit with the
        // caller's retry (-1 for a defer, the climbing count for a backoff).
        this._at = lease.at;
        this._retry = lease.retry;
        this._deferred_at = lease.due;
        return undefined;
      }
      this._retry = -1;
      this._at = lease.at;
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

  block(lease: Lease, error: string) {
    // Re-blocking is a no-op, like the SQL `AND blocked = false` guard.
    if (this._leased_by === lease.by && !this._blocked) {
      this._blocked = true;
      this._error = error;
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

  /** Retry resets to -1 (released); the next claim makes it 0. */
  reset() {
    this._at = -1;
    this._retry = -1;
    this._blocked = false;
    this._error = "";
    this._leased_by = undefined;
    this._leased_until = undefined;
    this._deferred_at = undefined;
  }

  /** True only when the stream was blocked. */
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
 * In-memory event store: the default when no other store is injected.
 * For development, tests and examples; all data is lost when the process
 * exits. Use {@link PostgresStore} in production.
 *
 * `Store.notify` is not implemented: a single process has no remote writer
 * to hear from, and local commits already arm the drain.
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
 * @see {@link Store} for the interface definition
 * @see {@link PostgresStore} for production use
 * @see {@link store} for injecting stores
 *
 * @category Adapters
 */
export class InMemoryStore implements Store {
  private _events: Committed<Schemas, keyof Schemas>[] = [];
  // Never reused. Deletions punch holes, so ids are not array indexes.
  private _next_id = 0;
  private _streams: Map<string, InMemoryStream> = new Map();
  /** Correlate checkpoint: how far the log has been READ. */
  private _correlated_at = -1;
  /** Per-correlator checkpoint and lease; keyless callers use `_correlated_at`. */
  private _correlators = new Map<
    string,
    { at: number; by: string; until: number }
  >();
  private _stream_versions: Map<string, number> = new Map();
  // stream → (event_id → cloned pii). Two levels so `forget_pii` drops one
  // inner Map. Absence means no PII.
  private _pii: Map<string, Map<number, Record<string, unknown>>> = new Map();

  private _reset_indexes() {
    this._events.length = 0;
    this._next_id = 0;
    this._correlated_at = -1;
    this._stream_versions.clear();
    this._pii.clear();
  }

  // Stores a cloned copy, so caller-side mutation can't reach it.
  private _put_pii(stream: string, id: number, pii: Record<string, unknown>) {
    let per_stream = this._pii.get(stream);
    if (!per_stream) {
      per_stream = new Map();
      this._pii.set(stream, per_stream);
    }
    per_stream.set(id, structuredClone(pii));
  }

  // First index whose id is greater than `after` (ids are sorted, not dense).
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

  // Allocation-free for events without PII, the common case.
  private _with_pii<E extends Schemas>(
    e: Committed<E, keyof E>,
    wanted = true
  ): Committed<E, keyof E> {
    if (!wanted) return e;
    const pii = this._pii.get(e.stream)?.get(e.id);
    return pii ? ({ ...e, pii } as Committed<E, keyof E>) : e;
  }

  async dispose() {
    await sleep();
    this._reset_indexes();
  }

  async seed() {
    await sleep();
  }

  async drop() {
    await sleep();
    this._reset_indexes();
    this._streams = new Map();
  }

  private in_query<E extends Schemas>(
    query: Query,
    e: Committed<E, keyof E>
  ): boolean {
    if (query.stream && !this._stream_matches(query.stream, query, e.stream))
      return false;
    if (query.names && !query.names.includes(e.name as string)) return false;
    if (query.correlation && e.meta?.correlation !== query.correlation)
      return false;
    if (e.name === SNAP_EVENT && !query.with_snaps) return false;
    // `created` is not monotonic with `id` (restore keeps it), so time
    // bounds filter; they never end the scan.
    if (query.created_after && e.created <= query.created_after) return false;
    if (query.created_before && e.created >= query.created_before) return false;
    return true;
  }

  private _stream_matches(pattern: string, query: Query, stream: string) {
    return query.stream_exact
      ? stream === pattern
      : RegExp(pattern).test(stream);
  }

  /** Index of the stream's latest snapshot, or -1; an explicit `after` wins. */
  private _snap_floor(query: Query | undefined): number {
    if (
      !query?.with_snaps ||
      !query.stream_exact ||
      query.stream === undefined ||
      query.after !== undefined
    )
      return -1;
    for (let j = this._events.length - 1; j >= 0; j--) {
      const e = this._events[j];
      if (e.stream === query.stream && e.name === SNAP_EVENT) return j;
    }
    return -1;
  }

  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) {
    await sleep();
    // The id bounds (`after`, `before`, the snapshot floor) are one index
    // window over the id-ordered log; every other filter is per event.
    const floor = this._snap_floor(query);
    const lo = floor >= 0 ? floor : this._first_index_after(query?.after ?? -1);
    const hi =
      query?.before !== undefined
        ? this._first_index_after(query.before - 1)
        : this._events.length;
    const with_pii = query?.with_pii !== false;
    let count = 0;
    for (let k = 0; k < hi - lo; k++) {
      const e = this._events[query?.backward ? hi - 1 - k : lo + k];
      if (query && !this.in_query(query, e)) continue;
      await Promise.resolve(
        callback(this._with_pii(e as Committed<E, keyof E>, with_pii))
      );
      count++;
      if (query?.limit && count >= query.limit) break;
    }
    return count;
  }

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
      // Stored pii-less, so `forget_pii` never touches the event row.
      this._events.push(c as Committed<Schemas, keyof Schemas>);
      if (pii != null) this._put_pii(stream, c.id, pii);
      version++;
      return this._with_pii(c);
    });
    this._stream_versions.set(stream, version - 1);
    return committed;
  }

  async claim(
    lagging: number,
    leading: number,
    by: string,
    millis: number,
    lane?: string
  ) {
    await sleep();
    // Eligibility is `at < correlated_at` on the row alone; the event log
    // is never read. An unmarked row is not claimable.
    const has_work = (s: InMemoryStream): boolean =>
      s.correlated_at !== undefined && s.at < s.correlated_at;
    const available = [...this._streams.values()].filter(
      (s) =>
        s.is_available && has_work(s) && (lane === undefined || s.lane === lane)
    );
    // Lagging: priority DESC, then watermark ASC, like the PG SQL. The
    // `fair` slots ignore priority so sustained high-priority load can't
    // starve a default-priority stream.
    const fair = lagging >= 2 ? Math.max(1, Math.floor(lagging / 4)) : 0;
    const by_priority = [...available].sort(
      (a, b) => b.priority - a.priority || a.at - b.at
    );
    const priority_slice = by_priority.slice(0, lagging - fair);
    const picked = new Set(priority_slice.map((s) => s.stream));
    const fair_slice = [...available]
      .sort((a, b) => a.at - b.at)
      .filter((s) => !picked.has(s.stream))
      .slice(0, fair);
    const lag = [...priority_slice, ...fair_slice].map((s) => ({
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
    const seen = new Set<string>();
    const combined = [...lag, ...lead].filter((p) => {
      if (seen.has(p.stream)) return false;
      seen.add(p.stream);
      return true;
    });
    return combined
      .map((p) =>
        this._streams.get(p.stream)?.lease({ ...p, by, retry: 0 }, millis)
      )
      .filter((l) => !!l);
  }

  async subscribe(
    streams: SubscribeInput[],
    correlated_at?: number,
    correlator?: { key: string; by: string; millis: number }
  ) {
    await sleep();

    // The checkpoint is monotonic. With a correlator, position and lease
    // are per key.
    let correlating: boolean | undefined;
    let keyed_at: number | undefined;
    if (correlator) {
      const now = Date.now();
      const held = this._correlators.get(correlator.key);
      // A key with no row yet inherits the shared position, so a new
      // correlator does not re-read history.
      const at = Math.max(held?.at ?? this._correlated_at, correlated_at ?? -1);
      keyed_at = at;
      if (!held || held.until < now || held.by === correlator.by) {
        correlating = true;
        this._correlators.set(correlator.key, {
          at,
          by: correlator.by,
          // Release outright, or a successor in the same ms is still refused.
          until: correlator.millis > 0 ? now + correlator.millis : 0,
        });
      } else {
        // Refused, but the position still advances: this caller may already
        // have scanned and marked.
        correlating = false;
        held.at = at;
      }
      // How far any correlator has read.
      if (correlated_at !== undefined && correlated_at > this._correlated_at)
        this._correlated_at = correlated_at;
    } else if (
      correlated_at !== undefined &&
      correlated_at > this._correlated_at
    )
      this._correlated_at = correlated_at;

    let subscribed = 0;
    for (const {
      stream,
      source,
      priority = 0,
      lane = DEFAULT_LANE,
      correlated_at,
    } of streams) {
      const existing = this._streams.get(stream);
      if (existing) {
        // The lane rides the priority max (compared before the bump), so a
        // lower-priority resolution can't re-lane the stream.
        if (priority >= existing.priority) existing.lane = lane;
        existing.bump_priority(priority);
        if (correlated_at !== undefined) existing.mark(correlated_at);
      } else {
        const created = new InMemoryStream(stream, source, priority, lane);
        if (correlated_at !== undefined) created.mark(correlated_at);
        this._streams.set(stream, created);
        subscribed++;
      }
    }
    let watermark = -1;
    for (const s of this._streams.values()) {
      if (s.at > watermark) watermark = s.at;
    }
    return {
      subscribed,
      watermark,
      correlated_at: keyed_at ?? this._correlated_at,
      ...(correlating === undefined ? {} : { correlating }),
    };
  }

  async ack(leases: Lease[]) {
    await sleep();
    // One synchronous pass: the in-memory form of the single transaction.
    return leases
      .map((l) => this._streams.get(l.stream)?.ack(l))
      .filter((l) => !!l);
  }

  async block(leases: BlockedLease[]) {
    await sleep();
    return leases
      .map((l) => this._streams.get(l.stream)?.block(l, l.error))
      .filter((l) => !!l);
  }

  async defer(input: string[] | StreamFilter, deferred_at: number) {
    await sleep();
    const selected = this._select(input);
    for (const s of selected) s.defer(deferred_at);
    return selected.length;
  }

  /** De-duplicated like the SQL `stream = ANY(...)`; unknown names skipped. */
  private _select(input: string[] | StreamFilter): InMemoryStream[] {
    if (Array.isArray(input))
      return [...new Set(input)]
        .map((name) => this._streams.get(name))
        .filter((s) => s !== undefined);
    return [...this._streams.values()].filter(this._filter_predicate(input));
  }

  private _filter_predicate(
    filter: StreamFilter
  ): (s: InMemoryStream) => boolean {
    const stream_re =
      filter.stream !== undefined && !filter.stream_exact
        ? new RegExp(filter.stream)
        : undefined;
    const source_re =
      filter.source !== undefined && !filter.source_exact
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

  async reset(input: string[] | StreamFilter) {
    await sleep();
    const selected = this._select(input);
    for (const s of selected) s.reset();
    return selected.length;
  }

  async forget_pii(stream: string): Promise<number> {
    await sleep();
    const count = this._pii.get(stream)?.size ?? 0;
    this._pii.delete(stream);
    return count;
  }

  async unblock(input: string[] | StreamFilter) {
    await sleep();
    const selected = this._select(
      Array.isArray(input) ? input : { ...input, blocked: true }
    );
    return selected.filter((s) => s.unblock()).length;
  }

  async prioritize(filter: StreamFilter, priority: number) {
    await sleep();
    const changed = this._select(filter).filter((s) => s.priority !== priority);
    for (const s of changed) s.set_priority(priority);
    return changed.length;
  }

  async query_streams(
    callback: (position: StreamPosition) => void,
    query?: QueryStreams
  ): Promise<QueryStreamsResult> {
    await sleep();
    const limit = query?.limit ?? 100;
    const after = query?.after;
    const source_matches = query?.source_matches;
    const matches = this._filter_predicate(query ?? {});
    // Reverse-match: the stored `source` pattern must match a requested name.
    const reverse_cache = new Map<string, RegExp>();
    const reverse_match = (source: string): boolean => {
      let re = reverse_cache.get(source);
      if (!re) {
        re = new RegExp(source);
        reverse_cache.set(source, re);
      }
      return source_matches!.some((name) => re!.test(name));
    };

    // The default sort is code-unit order, which agrees with the `<=`
    // cursor and the SQL binary collation; `localeCompare` would not.
    const sorted = [...this._streams.keys()]
      .sort()
      .map((stream) => this._streams.get(stream) as InMemoryStream);

    let count = 0;
    for (const s of sorted) {
      if (after !== undefined && s.stream <= after) continue;
      if (!matches(s)) continue;
      if (source_matches !== undefined) {
        // No source consumes every stream, so it matches any name.
        if (s.source && !reverse_match(s.source)) continue;
      }
      // Before emitting, so `limit: 0` returns none.
      if (count >= limit) break;
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
        deferred_at: s.deferred_at,
        correlated_at: s.correlated_at,
      });
      count++;
    }
    return { maxEventId: this._events.at(-1)?.id ?? -1, count };
  }

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

    const array_targets = Array.isArray(input) ? new Set(input) : null;
    const filter = Array.isArray(input) ? null : input;
    const stream_re =
      filter?.stream !== undefined && !filter.stream_exact
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
        a.names![n] = (a.names![n] ?? 0) + 1;
      }
    }

    // Code-unit order, to agree with the `<=` cursor (see query_streams).
    const ordered = [...acc.keys()].sort();
    const out = new Map<string, StreamStats<E>>();
    for (const stream of ordered) {
      if (limit !== undefined && out.size >= limit) break;
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
    }
    return out;
  }

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

    // Per target, like the SQL adapters: a later target sees what an
    // earlier one in the same call already pruned.
    const windowed = targets.filter((t) => t.before !== undefined);
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
      const below = boundary.id;
      let deleted = 0;
      this._events = this._events.filter((e) => {
        if (e.stream !== stream || e.id >= below) return true;
        this._pii.get(stream)?.delete(e.id);
        deleted++;
        return false;
      });
      result.set(stream, { deleted, committed: boundary, before });
    }

    const full = targets.filter((t) => t.before === undefined);
    // Per target, like the SQL adapters, so a stream listed twice gets one seed.
    for (const { stream, snapshot, meta } of full) {
      let deleted = 0;
      this._events = this._events.filter((e) => {
        if (e.stream !== stream) return true;
        deleted++;
        return false;
      });
      // Subscriptions untouched; `seed()` reaps inert ones.
      this._stream_versions.delete(stream);
      this._pii.delete(stream);
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
      result.set(stream, { deleted, committed: event });
    }
    return result;
  }

  /** A throw inside the driver restores the captured state. Ids restart at 0. */
  async restore(
    driver: (
      callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
    ) => Promise<void>
  ): Promise<void> {
    await sleep();
    const prev_events = this._events;
    const prev_next_id = this._next_id;
    const prev_streams = this._streams;
    const prev_stream_versions = this._stream_versions;
    const prev_pii = this._pii;
    const prev_correlated_at = this._correlated_at;
    const prev_correlators = new Map(
      [...this._correlators].map(([k, v]) => [k, { ...v }])
    );
    // Renumbered from 0, so checkpoints restart too; leases are kept.
    this._correlated_at = -1;
    for (const c of this._correlators.values()) c.at = -1;
    this._events = [];
    this._next_id = 0;
    this._streams = new Map();
    this._stream_versions = new Map();
    this._pii = new Map();
    try {
      await driver(async (event) => {
        const id = this._next_id++;
        // Split `pii` out like `commit`, so `forget_pii` erases restored PII.
        const { pii, ...rest } = event;
        const committed: Committed<Schemas, keyof Schemas> = { ...rest, id };
        this._events.push(committed);
        if (pii != null) this._put_pii(event.stream, id, pii);
        // Last event per stream wins.
        this._stream_versions.set(event.stream, event.version);
        return id;
      });
    } catch (err) {
      this._events = prev_events;
      this._next_id = prev_next_id;
      this._streams = prev_streams;
      this._stream_versions = prev_stream_versions;
      this._pii = prev_pii;
      this._correlated_at = prev_correlated_at;
      this._correlators = prev_correlators;
      throw err;
    }
  }
}
