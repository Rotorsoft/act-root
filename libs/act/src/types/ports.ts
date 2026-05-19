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
  Schema,
  Schemas,
} from "./action.js";
import type { BlockedLease, Lease } from "./reaction.js";

/**
 * A function that disposes of a resource asynchronously.
 * @returns Promise that resolves when disposal is complete.
 */
export type Disposer = () => Promise<void>;

/**
 * An object that can be disposed of asynchronously.
 */
export type Disposable = { dispose: Disposer };

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Minimal logger port compatible with pino, winston, bunyan, and console.
 *
 * Each log method accepts either:
 * - `(msg: string)` — plain message
 * - `(obj: unknown, msg?: string)` — structured data with optional message
 *
 * Implementations should respect `level` to gate output.
 *
 * @see {@link ConsoleLogger} for the default implementation
 * @see {@link https://www.npmjs.com/package/@rotorsoft/act-pino | @rotorsoft/act-pino} for the Pino adapter
 */
export interface Logger extends Disposable {
  level: string;
  fatal(obj: unknown, msg?: string): void;
  fatal(msg: string): void;
  error(obj: unknown, msg?: string): void;
  error(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  warn(msg: string): void;
  info(obj: unknown, msg?: string): void;
  info(msg: string): void;
  debug(obj: unknown, msg?: string): void;
  debug(msg: string): void;
  trace(obj: unknown, msg?: string): void;
  trace(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Result of a {@link Store.truncate} operation, keyed by stream name.
 * Each entry contains the number of deleted events and the committed
 * seed event (snapshot or tombstone).
 */
export type TruncateResult = Map<
  string,
  { deleted: number; committed: Committed<Schemas, keyof Schemas> }
>;

/**
 * Payload delivered by {@link Store.notify} when a **different process**
 * commits one or more events to the same backing store.
 *
 * Notifications are emitted **per commit transaction**, not per event —
 * a single commit of N events produces one notification carrying all N
 * `events`. This matches transactional semantics, minimizes wire wakeups,
 * and lets handlers reason about atomic batches.
 *
 * Stores that implement `notify` self-filter their own commits — handlers
 * receive notifications only for cross-process activity. This is the signal
 * that lets a horizontally-scaled Act deployment wake `settle()` immediately
 * on remote commits, instead of waiting for the next poll/debounce cycle.
 *
 * @property stream - Stream that was committed to
 * @property events - Events in this commit (id + name), in commit order
 */
export type StoreNotification = {
  readonly stream: string;
  readonly events: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
  }>;
};

/**
 * Disposer returned by {@link Store.notify} subscriptions. Releases the
 * underlying listener (e.g., the dedicated PG `LISTEN` client). May be
 * synchronous or asynchronous — callers should `await` either way.
 */
export type NotifyDisposer = () => void | Promise<void>;

/**
 * Subscription position for a registered stream.
 *
 * Streamed by {@link Store.query_streams} to power operational dashboards
 * (projection lag, blocked subscriptions, in-flight leases). The shape
 * mirrors what every adapter already tracks on its `streams` table.
 *
 * @property stream - The subscription target (projection or reaction stream)
 * @property source - Optional source stream filter (for reactions)
 * @property at - Last processed event id watermark (-1 for fresh streams)
 * @property retry - Current retry counter
 * @property blocked - True when the stream is blocked by a poison message
 * @property error - Last error message (empty string when none)
 * @property leased_by - Current lease holder UUID (when leased)
 * @property leased_until - Lease expiration timestamp (when leased)
 * @property priority - Scheduling priority (default 0). Biases the
 *   lagging-frontier `claim()` ordering — see {@link Store.prioritize}.
 * @property lane - Drain lane bound to the stream (ACT-1103). Set on
 *   `subscribe()` from the reaction's `.to({lane})` declaration; updated
 *   on subsequent subscribes so a restarted Act with a new lane
 *   assignment wins. Optional during the lane rollout — adapters that
 *   haven't migrated omit the field; callers treat `undefined` as
 *   `"default"`.
 */
export type StreamPosition = {
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
  readonly retry: number;
  readonly blocked: boolean;
  readonly error: string;
  readonly priority: number;
  readonly leased_by?: string;
  readonly leased_until?: Date;
  readonly lane?: string;
};

/**
 * Filter options for {@link Store.query_streams}.
 *
 * Mirrors the {@link Query} pattern used by {@link Store.query} — pass
 * filters server-side to keep the cost low on large tables (e.g., dynamic
 * reactions producing one subscription per aggregate).
 *
 * **What the store can filter:** the columns it actually persists —
 * `stream`, `source`, `blocked`. Higher-level classification ("is this a
 * projection vs a reaction?", "is this a static or dynamic resolver?")
 * is an orchestrator concern; the streams table doesn't store kinds.
 * Layer that on top by joining results with `Act`'s built-in registry.
 *
 * @property stream - Stream-name filter. Interpreted as a regex by
 *   default — same anchor semantics across all stores (PG `~`, SQLite
 *   anchor-aware `LIKE`, InMemory JS `RegExp`). **Anchors are caller-
 *   controlled**: `^foo` for prefix, `foo$` for suffix, `^foo$` for
 *   whole-string match. A plain string `foo` is a substring match
 *   (matches any stream containing `foo`). Pass `stream_exact: true`
 *   for a fast literal-equality comparison that skips regex compilation.
 * @property stream_exact - Treat `stream` as a literal string instead
 *   of a regex.
 * @property source - Source-stream filter. Same anchor semantics as
 *   `stream`. Useful to isolate dynamic-reaction subscriptions tied to
 *   a particular aggregate stream. Pass `source_exact: true` for
 *   literal equality.
 * @property source_exact - Use exact match instead of pattern match for
 *   `source`.
 * @property blocked - Restrict to blocked (`true`) or unblocked (`false`)
 *   streams. Omit for all.
 * @property lane - Restrict to streams bound to this drain lane
 *   (ACT-1103). Exact-match only — lane names are short identifiers, not
 *   patterns. Omit to span every lane.
 * @property after - Keyset pagination cursor: returns only streams with
 *   `stream > after` (lexicographic). Pass the last seen `stream` to fetch
 *   the next page.
 * @property limit - Max rows to return (default: 100).
 */
export type QueryStreams = {
  readonly stream?: string;
  readonly stream_exact?: boolean;
  readonly source?: string;
  readonly source_exact?: boolean;
  readonly blocked?: boolean;
  readonly lane?: string;
  readonly after?: string;
  readonly limit?: number;
};

/**
 * Result of a {@link Store.query_streams} call.
 *
 * @property maxEventId - Highest event id in the store (-1 when empty).
 *   UI uses this to compute lag as `maxEventId - position.at`.
 * @property count - Number of stream positions delivered to the callback.
 */
export type QueryStreamsResult = {
  readonly maxEventId: number;
  readonly count: number;
};

/**
 * Filter shape for bulk operations on registered streams. Used by
 * {@link Store.prioritize}, {@link Store.reset}, and {@link Store.unblock}
 * — anything that operates on a set of streams selected by pattern or
 * exact match rather than enumerated by name.
 *
 * Same shape as {@link QueryStreams} but without pagination — bulk
 * UPDATEs don't paginate. Empty filter (`{}`) matches **every**
 * registered stream; treat as a footgun and use sparingly.
 *
 * @property stream - Stream-name filter (regex by default; `stream_exact`
 *   for equality).
 * @property stream_exact - Exact-match instead of regex.
 * @property source - Source-stream filter (regex by default;
 *   `source_exact` for equality).
 * @property source_exact - Exact-match instead of regex.
 * @property blocked - Restrict to blocked / unblocked streams. Omit
 *   for both.
 */
export type StreamFilter = Pick<
  QueryStreams,
  "stream" | "stream_exact" | "source" | "source_exact" | "blocked" | "lane"
>;

/**
 * Alias of {@link StreamFilter}. Retained for backward compatibility
 * with code that imports the filter by its prioritize-specific name.
 * Prefer `StreamFilter` for new code.
 */
export type PrioritizeFilter = StreamFilter;

/**
 * Framework-internal event names — written by the runtime, not by user
 * code. Snapshots are seeded by `truncate()`; tombstones by `close()`.
 *
 * Kept as a literal-string union here (rather than re-exported from
 * `../ports.js` where the runtime constants live) so {@link QueryStatsOptions.exclude}
 * can be type-checked without inducing a `types/` → `ports.ts` cycle.
 * The runtime constants {@link "../ports.js".SNAP_EVENT | SNAP_EVENT} and
 * {@link "../ports.js".TOMBSTONE_EVENT | TOMBSTONE_EVENT} (exported from
 * `@rotorsoft/act`) are the typed source of truth; this union mirrors
 * them at the type level.
 */
export type FrameworkEventName = "__snapshot__" | "__tombstone__";

/**
 * Union of all event names valid for a given schema set: user-declared
 * event names plus the framework-internal markers. Used by
 * {@link QueryStatsOptions.exclude} so callers can mix domain events and
 * framework markers in the same filter list without `as string` casts
 * or stringly-typed mistakes (e.g. `"__tombsotne__"` typos fail at
 * compile time).
 *
 * @template E - Event schemas; defaults to {@link Schemas}.
 */
export type EventName<E extends Schemas = Schemas> =
  | (keyof E & string)
  | FrameworkEventName;

/**
 * Per-stream aggregated stats returned by {@link Store.query_stats}.
 *
 * `head` and `tail` follow the **git-log convention**, not the Unix
 * `head`/`tail` convention:
 * - `head` — the **latest** event (highest id), always present.
 * - `tail` — the **earliest** event (lowest id), opt-in via
 *   {@link QueryStatsOptions.tail}.
 *
 * @template E - Event schemas; defaults to {@link Schemas} when the caller
 *   does not narrow.
 * @property head - Latest non-excluded event for the stream.
 * @property tail - Earliest non-excluded event for the stream, when
 *   `options.tail` is true.
 * @property count - Total non-excluded event count for the stream, when
 *   `options.count` is true.
 * @property names - Sparse map of event name → count of events with
 *   that name, when `options.names` is true. Keys are typed as
 *   {@link EventName | EventName<E>} so typos on lookup
 *   (e.g. `stats.names?.["TicktOpened"]`) fail at compile time when the
 *   caller narrows `E`. Empty object never returned — a stream with no
 *   matching events is absent from the result map entirely.
 */
export type StreamStats<E extends Schemas = Schemas> = {
  readonly head: Committed<E, keyof E>;
  readonly tail?: Committed<E, keyof E>;
  readonly count?: number;
  readonly names?: Readonly<Partial<Record<EventName<E>, number>>>;
};

/**
 * Options for {@link Store.query_stats}. All stat fields default to
 * `false` except `head`, which is always returned.
 *
 * **Cost model:** With no opt-in flags (or `tail` alone), each requested
 * stat resolves via an index-backed lookup — O(K) cost where K is the
 * number of matched streams. Setting `count` and/or `names` triggers a
 * full event scan over the matched streams (O(N) where N is total events);
 * both share the same scan and so requesting one is the same cost as
 * requesting both.
 *
 * @template E - Event schemas; defaults to {@link Schemas}. When the caller
 *   narrows `E`, `exclude` is type-checked against the schema's event names
 *   — typos like `["TOMBSTON_EVENT"]` fail at compile time.
 * @property tail - Include the earliest non-excluded event per stream.
 *   Cheap when alone (indexed); free when `count`/`names` also set
 *   (already scanning).
 * @property count - Include the total non-excluded event count per stream.
 *   Triggers full scan.
 * @property names - Include a `name → count` map per stream. Triggers
 *   full scan (shares cost with `count`).
 * @property exclude - Event names to skip — e.g.
 *   `[TOMBSTONE_EVENT, SNAP_EVENT]` to ignore framework markers. Applies
 *   to all returned stats (head, tail, count, names) consistently.
 * @property before - Time-travel cutoff: only consider events with
 *   `id < before`. Omitted = current state. Useful for "what did this
 *   stream look like at event N?" historical queries without changing
 *   the call shape. Cheap on both code paths (cheap-heads path narrows
 *   the index scan; full-scan path adds a `WHERE id < ?` predicate).
 */
export type QueryStatsOptions<E extends Schemas = Schemas> = {
  readonly tail?: boolean;
  readonly count?: boolean;
  readonly names?: boolean;
  readonly exclude?: ReadonlyArray<EventName<E>>;
  readonly before?: number;
};

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
   * @param query - Optional filter criteria — see {@link Query} for fields
   *   (`stream`, `name`, `after`, `before`, `created_after`, `created_before`,
   *   `limit`, `with_snaps`, `stream_exact`).
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
   * Atomically discovers and leases streams for reaction processing.
   *
   * Atomically discovers a stream and acquires a lease in one round-trip,
   * eliminating the race that exists when discovery and locking are separate
   * calls (a competing worker can grab the stream between the two).
   *
   * PostgresStore uses `FOR UPDATE SKIP LOCKED` for zero-contention competing
   * consumer semantics — workers never block each other, each grabbing different
   * streams atomically. InMemoryStore fuses its poll+lease logic equivalently.
   *
   * Used by `Act.drain()` as the primary stream acquisition method.
   *
   * @param lagging - Max streams from the lagging frontier (ascending watermark)
   * @param leading - Max streams from the leading frontier (descending watermark)
   * @param by - Unique lease holder identifier (UUID)
   * @param millis - Lease duration in milliseconds
   * @param lane - Optional lane filter (ACT-1103). When set, restricts
   *   the claim to streams bound to the named lane. When omitted, the
   *   adapter spans every lane — preserving today's single-controller
   *   semantics. Capability-gated in the TCK so adapters can adopt
   *   lane filtering incrementally.
   * @returns Array of successfully leased streams with metadata
   *
   * @example
   * ```typescript
   * const leased = await store().claim(5, 5, randomUUID(), 10000);
   * leased.forEach(({ stream, at, lagging }) => {
   *   console.log(`Leased ${stream} at ${at} (lagging: ${lagging})`);
   * });
   * ```
   *
   * @example Lane-restricted claim
   * ```typescript
   * const slow = await store().claim(5, 5, randomUUID(), 60_000, "slow");
   * ```
   *
   * @see {@link subscribe} for registering new streams (used by correlate)
   * @see {@link ack} for acknowledging completion
   * @see {@link block} for blocking failed streams
   */
  claim: (
    lagging: number,
    leading: number,
    by: string,
    millis: number,
    lane?: string
  ) => Promise<Lease[]>;

  /**
   * Registers streams for event processing.
   *
   * Upserts stream entries so they become visible to {@link claim}. Used by
   * `correlate()` to register dynamically discovered reaction target streams.
   *
   * Also returns the current maximum watermark across all subscribed streams,
   * used internally for correlation checkpoint initialization on cold start.
   *
   * @param streams - Streams to register with optional source hint
   * @returns `subscribed` count of newly registered streams, `watermark` max `at` across all streams
   *
   * @example
   * ```typescript
   * const { subscribed, watermark } = await store().subscribe([
   *   { stream: "stats-user-1", source: "user-1" },
   *   { stream: "stats-user-2", source: "user-2", priority: 10 },
   * ]);
   * ```
   *
   * @see {@link claim} for discovering and leasing registered streams
   * @see {@link prioritize} for changing priority after subscription
   */
  subscribe: (
    streams: Array<{
      stream: string;
      source?: string;
      /**
       * Optional scheduling priority for the lagging-frontier
       * `claim()` ordering. Default `0`. When the same stream is
       * subscribed by multiple reactions with different priorities,
       * implementations must keep the **maximum** so the highest-
       * priority reaction wins. Use {@link prioritize} for runtime
       * overrides that ignore this max — operator-driven changes.
       */
      priority?: number;
      /**
       * Drain lane this stream is bound to (ACT-1103). Omitted means
       * the implicit `"default"` lane. On every `subscribe()` call the
       * adapter UPSERTs the row's `lane` to this value — so a restarted
       * Act with a new lane assignment wins over the previously stored
       * lane. Online re-laning (while workers hold leases) is **not**
       * supported; the safe re-laning trigger is process restart.
       */
      lane?: string;
    }>
  ) => Promise<{ subscribed: number; watermark: number }>;

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
   * const leased = await store().claim(5, 5, randomUUID(), 10000);
   * // Process events up to ID 150
   * await store().ack(leased.map(l => ({ ...l, at: 150 })));
   * ```
   *
   * @see {@link claim} for acquiring leases
   */
  ack: (leases: Lease[]) => Promise<Lease[]>;

  /**
   * Blocks streams after persistent processing failures.
   *
   * Blocked streams won't be returned by {@link claim} until manually unblocked.
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
   * @see {@link claim} for lease management
   */
  block: (leases: BlockedLease[]) => Promise<BlockedLease[]>;

  /**
   * Resets watermarks for the given streams to -1, making them eligible
   * for replay from the beginning. Also clears retry, blocked, error,
   * and lease state so the streams can be claimed immediately.
   *
   * **Prefer `Act.reset()` over calling this directly.** This primitive
   * only resets the store; it does not raise the orchestrator's internal
   * "needs drain" flag, so a settled `Act` instance will short-circuit and
   * skip the replay. `Act.reset()` wraps this and arms the flag.
   *
   * Accepts either an explicit list of stream names or a
   * {@link StreamFilter} for bulk operations (e.g., "rebuild every
   * blocked stream"). The filter form is the same shape used by
   * {@link prioritize} and {@link query_streams}. An empty filter
   * (`{}`) matches every registered stream — typically a footgun for
   * `reset`; prefer narrower filters like `{ blocked: true }`.
   *
   * @param input - Stream names or a {@link StreamFilter}
   * @returns Count of streams that were actually reset
   *
   * @example
   * ```typescript
   * // By name
   * await app.reset(["my-projection"]);
   *
   * // By filter — rebuild every blocked stream in a projection family
   * await app.reset({ stream: "^proj-orders-", blocked: true });
   *
   * // Low-level (does NOT trigger replay on settled apps)
   * await store().reset(["my-projection"]);
   * ```
   *
   * @see {@link Act.reset} for the high-level rebuild API that wraps
   *   this primitive and arms the orchestrator's drain flag
   */
  reset: (input: string[] | StreamFilter) => Promise<number>;

  /**
   * Clears the blocked flag on streams without replaying their history.
   * Sets `blocked = false`, `retry_count = 0`, `error = null`, and
   * clears any lease bookkeeping. The `at` watermark stays where it
   * was — the stream resumes from the next event after the last
   * successful ack, not from zero.
   *
   * The distinction from {@link reset} matters: `reset()` is for
   * projection rebuilds (replay from event 0); `unblock()` is for
   * recovering from a poison message after the operator fixes the
   * underlying issue. Use `unblock()` when you don't want to re-process
   * history.
   *
   * **Prefer `Act.unblock()` over calling this directly.** Like
   * `reset()`, this primitive doesn't raise the orchestrator's internal
   * "needs drain" flag — a settled `Act` instance will short-circuit and
   * skip the resume. `Act.unblock()` wraps this and arms the flag.
   *
   * Only streams that were actually blocked at call time count toward
   * the return value; already-unblocked streams and unknown stream
   * names are silently skipped. The atomic single-statement update
   * makes the call safe to issue concurrently with `claim()` — workers
   * holding a `FOR UPDATE SKIP LOCKED` lock won't see partial state.
   *
   * Accepts either an explicit list of stream names or a
   * {@link StreamFilter} for bulk recovery (e.g., "unblock every
   * blocked order projection"). The `blocked = true` predicate is
   * always applied — passing `blocked: false` in the filter matches
   * nothing. An empty filter (`{}`) means "unblock everything that's
   * blocked," which is a sane post-incident bulk recovery.
   *
   * @param input - Stream names or a {@link StreamFilter}
   * @returns Count of streams that were actually flipped (were blocked)
   *
   * @example
   * ```typescript
   * // By name (single targeted recovery)
   * await app.unblock(["webhooks-out-customer-42"]);
   *
   * // By filter — unblock every blocked stream in a family
   * await app.unblock({ stream: "^webhooks-out-" });
   *
   * // Post-incident: unblock everything that's blocked
   * await app.unblock({});
   *
   * // Low-level (does NOT trigger resume on settled apps)
   * await store().unblock(["webhooks-out-customer-42"]);
   * ```
   *
   * @see {@link Act.unblock} for the high-level recovery API
   * @see {@link reset} for the rebuild-from-zero alternative
   */
  unblock: (input: string[] | StreamFilter) => Promise<number>;

  /**
   * Bulk-update the scheduling priority of streams matching a filter.
   *
   * Used by {@link Act.prioritize} for operator runtime control over
   * lagging-frontier `claim()` ordering. Unlike {@link subscribe},
   * which keeps the per-stream priority at the `max()` of all
   * registered reactions targeting that stream, `prioritize` sets the
   * priority **directly** to `priority` for matching rows — letting
   * operators override the build-time scheduling policy.
   *
   * Filter semantics mirror {@link query_streams}: `stream`/`source`
   * are regex by default, exact with the `*_exact` flags. `blocked`
   * restricts to blocked or unblocked rows. Omitted fields don't
   * filter. An **empty filter** (`{}`) updates every registered
   * stream — useful for "reset all priorities to N" but a footgun
   * otherwise.
   *
   * @param filter - {@link PrioritizeFilter} selecting which streams
   *   to update. Required (use `{}` to target all).
   * @param priority - New priority value. Set as-is — no `max()`,
   *   no clamp.
   * @returns Count of streams whose priority was changed.
   *
   * @example Boost a specific replay
   * ```typescript
   * await store().prioritize(
   *   { stream: "^projection-orders$", stream_exact: false },
   *   10
   * );
   * ```
   *
   * @example De-prioritize all background projections
   * ```typescript
   * await store().prioritize({ source: "^audit-" }, -5);
   * ```
   *
   * @see {@link Act.prioritize} for the orchestrator-level wrapper
   * @see {@link claim} for how priority biases stream scheduling
   */
  prioritize: (filter: StreamFilter, priority: number) => Promise<number>;

  /**
   * Atomically truncates streams and seeds each with a final event.
   *
   * For each target, in a single transaction:
   * 1. Deletes all events for the stream
   * 2. Removes the stream's entry from the streams table
   * 3. Inserts a `__snapshot__` (when `snapshot` is provided) or
   *    `__tombstone__` event as the sole event on the stream
   *
   * @param targets - Streams to truncate with optional snapshot state and meta
   * @returns Map keyed by stream name, each entry with `deleted` count and `committed` event
   *
   * @see {@link Act.close} for the high-level close-the-books API that
   *   orchestrates safety checks, archive callbacks, and atomic
   *   truncate+seed
   */
  truncate: (
    targets: Array<{
      stream: string;
      snapshot?: Schema;
      meta?: EventMeta;
    }>
  ) => Promise<TruncateResult>;

  /**
   * Streams registered subscription positions to a callback, plus the
   * highest event id in the store.
   *
   * Read-only introspection for operational dashboards (Store /
   * Subscriptions tab, projection lag, blocked subscriptions). Avoids
   * forcing apps to open a second connection and run raw SQL against
   * adapter-specific schemas.
   *
   * Mirrors the {@link Store.query} callback pattern: the callback is
   * invoked once per matching position, allowing large result sets to be
   * processed without buffering. Results are ordered by `stream` name; use
   * `query.after` (last seen stream name) for keyset pagination on big
   * tables (dynamic reactions can produce one subscription per aggregate).
   *
   * @param callback - Invoked once per matching {@link StreamPosition}.
   * @param query - Optional {@link QueryStreams} filter (default `limit: 100`).
   * @returns `maxEventId` and the `count` of positions emitted.
   *
   * @example List blocked streams with their lag
   * ```typescript
   * const { maxEventId } = await store().query_streams(
   *   (s) => console.log(`${s.stream}: lag=${maxEventId - s.at} ${s.error}`),
   *   { blocked: true, limit: 50 }
   * );
   * ```
   *
   * @example Page through all positions
   * ```typescript
   * let after: string | undefined;
   * for (;;) {
   *   const page: StreamPosition[] = [];
   *   const { count } = await store().query_streams(
   *     (s) => page.push(s),
   *     { after, limit: 100 }
   *   );
   *   if (!count) break;
   *   // ... use page ...
   *   after = page.at(-1)?.stream;
   * }
   * ```
   */
  query_streams: (
    callback: (position: StreamPosition) => void,
    query?: QueryStreams
  ) => Promise<QueryStreamsResult>;

  /**
   * Per-stream aggregated stats — single round trip per adapter.
   *
   * Returns the latest event (`head`) plus opt-in extras (`tail`, `count`,
   * `names`) for each stream selected by `input`. Streams with no
   * qualifying events are absent from the result map.
   *
   * **Cost model.** With no opt-in flags, the call uses an index-backed
   * head lookup per stream — O(K) where K is the number of matched
   * streams. `tail` alone stays in the cheap tier. Setting `count` and/or
   * `names` triggers a full event scan over the matched streams (O(N)
   * where N is total events); both stats share that scan, so requesting
   * one or both is the same cost.
   *
   * **`input`.** Either an explicit `string[]` of stream names, or a
   * narrow event-stream selector `{ stream?, stream_exact? }` for
   * pattern-based or exact-name matching. **Subscription-level filters
   * (`source`, `blocked`) are intentionally not accepted here** — they
   * describe subscriptions, not events, and conflating the two would
   * silently exclude unsubscribed event streams. For
   * "stats for all blocked subscriptions" compose explicitly:
   * `query_streams({blocked: true})` → collect names → `query_stats(names)`.
   *
   * **`head` vs `tail` naming.** Follows the git-log convention: `head`
   * is the latest event (highest id), `tail` is the earliest (lowest id).
   * This is the **opposite** of the Unix `head`/`tail` commands.
   *
   * **Framework markers.** Snapshots (`__snapshot__`) and tombstones
   * (`__tombstone__`) are real events and are included by default —
   * intentional, so schema-evolution tooling can count them. To exclude
   * them, pass them in `options.exclude` (typed against {@link EventName})
   * so typos are compile-time errors.
   *
   * **Snapshot counts come from `names`.** When `names: true` and snapshots
   * are not in `exclude`, `result.names["__snapshot__"]` is the snapshot
   * count for that stream — no separate field needed. Validates snapshot
   * policy at scale: `names["__snapshot__"] / count` should match the
   * configured snap predicate's expected ratio.
   *
   * **Time travel.** `options.before` narrows to events with `id < before`,
   * answering "what did this stream look like at event N?" without
   * special call shape.
   *
   * @example Cheap heads — close-cycle pattern (one round trip, no scan)
   * ```typescript
   * const stats = await store().query_stats(streams, {
   *   exclude: [TOMBSTONE_EVENT],
   * });
   * for (const [stream, { head }] of stats) {
   *   // head.id, head.version, head.name
   * }
   * ```
   *
   * @example Full stats — inspector / admin dashboard (one full scan)
   * ```typescript
   * const stats = await store().query_stats<MyEvents>(
   *   { stream: "^orders-" },
   *   { count: true, tail: true, names: true,
   *     exclude: [TOMBSTONE_EVENT] }
   * );
   * for (const [stream, s] of stats) {
   *   const snaps = s.names?.[SNAP_EVENT] ?? 0;
   *   const domain = (s.count ?? 0) - snaps;
   *   console.log(stream, { snaps, domain, tail: s.tail?.created });
   * }
   * ```
   *
   * @example Schema-evolution — surface deprecated events per stream
   * ```typescript
   * const stats = await store().query_stats<TicketEvents>(
   *   { stream: "^ticket-" },
   *   { names: true }
   * );
   * for (const [stream, { names = {} }] of stats) {
   *   if ((names["TicketOpened"] ?? 0) > 0) {
   *     console.log(`${stream}: ${names["TicketOpened"]} legacy events`);
   *   }
   * }
   * ```
   *
   * @example Time travel — stream state at a historical cutoff
   * ```typescript
   * const stats = await store().query_stats(["order-42"], {
   *   before: 100_000, // events up to (not including) id 100000
   *   tail: true,
   * });
   * const { head, tail } = stats.get("order-42") ?? {};
   * // head = latest event with id < 100_000; tail = earliest in range
   * ```
   *
   * @template E - Event schemas. Narrow at the call site to type-check
   *   `exclude` against your event names (typos fail at compile time).
   *
   * @param input - Stream names or a filter selecting the streams to stat.
   * @param options - Opt-in stat fields, event-name exclusions, and
   *   time-travel cutoff. See {@link QueryStatsOptions}.
   * @returns Map keyed by stream name. Streams with no qualifying events
   *   (after `exclude` and `before` are applied) are absent.
   *
   * @see {@link QueryStatsOptions} for the cost-aware option surface
   * @see {@link StreamStats} for the per-stream result shape
   * @see {@link EventName} for the typed exclude entries
   */
  query_stats: <E extends Schemas>(
    input: string[] | Pick<StreamFilter, "stream" | "stream_exact">,
    options?: QueryStatsOptions<E>
  ) => Promise<Map<string, StreamStats<E>>>;

  /**
   * Optional cross-process commit notifications.
   *
   * When implemented, the {@link Act} orchestrator subscribes once at build
   * time and routes notifications to wake `settle()` automatically — so a
   * remote worker's commit triggers reactions on this process without
   * waiting for the debounce/poll cycle. Subscribers also receive each
   * notification on the `"notified"` lifecycle event for fan-out
   * (SSE pushes, audit logs, dashboards).
   *
   * **Self-filtering contract:** implementations must skip their own
   * commits. The handler fires only for commits originating from a
   * **different process** writing to the same backing store. This keeps
   * the local fast path (`do()` already arms drain) free of duplicate
   * wake-ups and gives `"notified"` a clean cross-process semantic.
   *
   * **Hint, not a contract:** the orchestrator never depends on `notify`
   * for correctness. If absent, dropped, or the store omits it, the
   * existing debounce/poll path still drains correctly — `notify` only
   * lowers cross-process p99 reaction latency.
   *
   * Adapter status (Act 0.x):
   * - {@link PostgresStore}: implemented via `LISTEN`/`NOTIFY` on the
   *   `act_commit` channel
   * - {@link InMemoryStore}: not implemented (single-process — no remote
   *   writers exist)
   * - `SqliteStore`: not implemented (single-node by design)
   *
   * @param handler Callback invoked once per remote commit
   * @returns Disposer releasing the underlying listener
   */
  notify?: (
    handler: (notification: StoreNotification) => void
  ) => NotifyDisposer | Promise<NotifyDisposer>;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * A cached snapshot entry for a stream.
 *
 * @template TState - The state schema type
 */
export interface CacheEntry<TState extends Schema> {
  readonly state: TState;
  readonly version: number;
  readonly event_id: number;
  readonly patches: number;
  readonly snaps: number;
}

/**
 * Cache port for storing stream snapshots in-process.
 *
 * Implementations should provide fast key-value access with bounded memory.
 * The async interface is forward-compatible with external caches (e.g., Redis).
 *
 * @template TState - The state schema type
 */
export interface Cache extends Disposable {
  get<TState extends Schema>(
    stream: string
  ): Promise<CacheEntry<TState> | undefined>;
  set<TState extends Schema>(
    stream: string,
    entry: CacheEntry<TState>
  ): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
