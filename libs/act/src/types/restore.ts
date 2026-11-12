/**
 * @module act/types/restore
 * Types for restore and transfer: the scan options and result, the source
 * an `IAct.restore` reads and the sink it writes.
 */
import type { Committed, Query, Schemas } from "./action.js";
import type { Disposable } from "./ports.js";

/**
 * Options for the orchestrator's restore scan loop, consumed by
 * {@link IAct.restore} (and threaded through to the internal `scan`).
 * Adapters never see these — they're entirely interpreted on the
 * orchestrator side.
 *
 * Compaction flags ({@link drop_snapshots}, {@link drop_closed_streams})
 * and the migration overlay ({@link event_migrations},
 * {@link stream_rename}) all apply per event before the sink writes
 * anything. Any throw aborts the whole scan — atomic rollback in the
 * sink means a failing transform leaves the target byte-for-byte
 * unchanged.
 */
export type ScanOptions = {
  /**
   * Skip events with `name === SNAP_EVENT`. The next snap policy
   * regenerates snapshots against current code; useful for backups
   * that should compact stale snapshot bytes. Counted in
   * {@link ScanResult.dropped}`.snapshots`.
   *
   * Single-pass: no source-shape implications. Default `false`.
   */
  readonly drop_snapshots?: boolean;

  /**
   * Optional progress callback. The scan loop fires it once per event
   * during iteration. Three fields:
   *
   *   - `processed` — running 1-based count of events processed.
   *   - `id` — current event's id.
   *   - `max_id` — highest id in the source, probed once at scan start
   *     via `source.query(noop, { backward: true, limit: 1 })`. O(1) on
   *     indexed stores. Left `undefined` when the probe can't determine
   *     it (e.g. `CsvFile`-style sources that ignore the filter and
   *     stream more than one event from the probe call).
   *
   * UIs render either `processed / ?` (event count) or `id / max_id`
   * (position through the id space) depending on need.
   *
   * Synchronous handler — the scan loop calls it directly.
   * **Throttling / batching is the caller's responsibility**: for a
   * million-event restore, debounce in the handler rather than
   * expecting the loop to coalesce calls. Keeping it unthrottled
   * means callers that want every-event reporting get it without a
   * config knob.
   */
  readonly on_progress?: (p: {
    processed: number;
    id: number;
    max_id?: number;
  }) => void;

  /**
   * Per-batch row count for the scan pagination loop. Each
   * call to `source.query` requests `limit: batch_size` and `after:
   * <last id seen>`. Default `500`. Lower values trade round trips for
   * memory; higher values approach the cost of an unbounded query.
   */
  readonly batch_size?: number;

  /**
   * When `true`, {@link IAct.restore} runs the scan loop without
   * touching the store — events are validated and counted but no
   * transaction is opened and no rows are written. Returned `kept` /
   * `dropped` reflect what a subsequent destructive restore against
   * the same source would land; a throw means the source has a
   * blocker (the running index pinpoints it).
   *
   * No `Store.restore` capability is required for a dry-run — the
   * adapter is never called. Default `false`.
   */
  readonly dry_run?: boolean;

  /**
   * Compact streams that have been closed (tombstoned) via
   * {@link IAct.close}. The scan walks the source once
   * upfront to collect streams with a `__tombstone__` event, then
   * the main loop drops every **pre-close event** whose stream is in
   * that set. The tombstone itself is **kept** — it's the gate that
   * makes {@link IAct.do} throw `StreamClosedError` in the rebuilt
   * store, so dropping it would silently reopen the stream.
   *
   * Useful for compaction during transfer: the new (migrated) store
   * keeps the close gate but drops the historical detail.
   *
   * Counted in {@link ScanResult.dropped}`.closed_streams` (pre-close
   * events only; the tombstone is counted in `kept`).
   *
   * Default `false`.
   */
  readonly drop_closed_streams?: boolean;

  /**
   * Per-event migrations applied during scan. Keys are
   * source event names; values describe how to rewrite the event into
   * its current-version form before the sink writes it.
   *
   * Transfer-time only — never registered at app build time and never
   * auto-applied to a live store. Operators configure migrations
   * explicitly per-call (typically through the inspector's transfer
   * dialog when moving from an old store to a new one).
   *
   * Each row that matches a key:
   *   1. parses `event.data` against `from_schema` (validates source);
   *   2. runs `migrate(parsed)` to transform the payload;
   *   3. parses the result against `to_schema` (validates target);
   *   4. is rewritten with `name = to` and `data = migrated`.
   *
   * Any throw aborts the whole scan — atomic transaction rollback in
   * the sink means a failing migration leaves the target byte-for-byte
   * unchanged.
   */
  // `any`: heterogeneous per-key migrations
  readonly event_migrations?: Record<string, EventMigration<any, any>>;

  /**
   * Per-stream rename applied during scan. The returned string
   * replaces `event.stream` and the streams named in its causation. Useful for
   * tenant relocation (`s => s.replace(/^old-tenant-/, "new-tenant-")`)
   * or prefix cleanup.
   *
   * Applied AFTER {@link event_migrations} so the migration sees the
   * original stream name (in case the migration's `migrate` function
   * inspects it).
   */
  readonly stream_rename?: (stream: string) => string;
};

/**
 * Per-event migration definition for {@link ScanOptions.event_migrations}.
 * Carries both the rename target and the schema-guarded transform that
 * rewrites the event's `data` payload.
 */
export type EventMigration<TOld, TNew> = {
  /** Target event name (the current version). */
  readonly to: string;
  /** Schema of the source event's `data`. Throws on mismatch. */
  readonly from_schema: { parse: (data: unknown) => TOld };
  /** Schema of the migrated event's `data`. Throws on mismatch. */
  readonly to_schema: { parse: (data: unknown) => TNew };
  /** Pure data transformer. */
  readonly migrate: (data: TOld) => TNew;
};

/**
 * Result of {@link IAct.restore}.
 *
 * `kept` and `duration_ms` are always populated. `dropped` carries
 * per-category counters when {@link ScanOptions.drop_snapshots} (or
 * future compaction flags) trigger drops; otherwise zeros. Live
 * restore is atomic — any error throws and rolls back, so there's no
 * per-event error reporting on the result.
 */
export type ScanResult = {
  /** Number of events written to the rebuilt store. */
  readonly kept: number;
  /** Wall-clock duration of the call, in milliseconds. */
  readonly duration_ms: number;
  /** Per-category drop counters. */
  readonly dropped: {
    readonly closed_streams: number;
    readonly snapshots: number;
  };
  /** Events rewritten by {@link ScanOptions.event_migrations}. */
  readonly migrated: number;
};

/**
 * Construct a {@link CsvFile} from either a filesystem path (for
 * reading and/or writing through the OS) or an in-memory blob (a
 * pre-loaded CSV string, used by the inspector when a CSV arrives
 * over the wire via tRPC).
 *
 * Both modes share the same on-disk format, so the same blob shape
 * can be round-tripped through the transfer pipeline.
 */
export type CsvFileOptions = { path: string } | { blob: string };

/**
 * Read end of the transfer pipeline. Anything
 * that exposes a `Store.query`-shaped reader plus `dispose` can be
 * used as a source for {@link IAct.restore}.
 *
 * `Store` extends this interface; the framework's `CsvFile` utility
 * implements it on top of file I/O so a CSV can be a transfer
 * source. The pipeline never sees a discriminator — both ends speak
 * the same shape.
 */
export interface EventSource extends Disposable {
  /**
   * Read events into a per-event callback. Adapters MUST `await
   * Promise.resolve(callback(event))` per event — sync callbacks
   * resolve immediately (zero overhead), async callbacks throttle
   * the read loop. This is the seam that lets `iterate()` apply
   * backpressure without changing the callback's declared return
   * type. Callback returns `void`, which TypeScript treats as
   * "return value ignored" — existing call sites passing
   * `e => arr.push(e)` (which returns `number`) keep working.
   */
  query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ): Promise<number>;
}

/**
 * Write end of the transfer pipeline. Anything
 * that can host the destructive driver-pattern `restore` HOF (atomic
 * wipe + per-event commit) is an `EventSink` — `Store` adapters
 * that ship the optional `restore` method, plus the framework's
 * `CsvFile` utility for "write to a file" targets.
 *
 * `restore` is required here (vs. optional on `Store`) because the
 * sink slot in {@link IAct.restore} demands a writer; non-restorable
 * stores satisfy {@link EventSource} only.
 */
export interface EventSink extends Disposable {
  restore(
    driver: (
      callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
    ) => Promise<void>
  ): Promise<void>;
}
