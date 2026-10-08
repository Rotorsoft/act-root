/**
 * @module close-cycle
 * @category Internal
 *
 * Pure orchestration of the close-the-books flow: scan stream heads,
 * partition by reaction safety, guard with tombstones, optionally seed
 * restart state, run user archive callbacks, atomically truncate, and
 * update the cache.
 *
 * Also home to the pieces a closer needs around the cycle: the per-stream
 * {@link CloseLock} and the bounded {@link catch_up_correlation}. The Act
 * orchestrator only wires its ports in and emits `"closed"`.
 *
 * @internal
 */

import { cache, SNAP_EVENT, store, TOMBSTONE_EVENT } from "../ports.js";
import type {
  CloseResult,
  CloseTarget,
  Logger,
  Schema,
  State,
} from "../types/index.js";
import type { EsOps } from "./event-sourcing.js";

/**
 * Dependencies the close cycle needs from the Act orchestrator. Decoupled
 * from `Act` itself so the cycle can be exercised from tests in isolation.
 *
 * @internal
 */
export type CloseCycleDeps = {
  readonly reactive_events_size: number;
  readonly event_to_state: ReadonlyMap<string, State<any, any, any>>;
  readonly load: EsOps["load"];
  readonly tombstone: EsOps["tombstone"];
  readonly logger: Logger;
  /**
   * Correlation id for the close transaction. Caller (`Act.close`)
   * computes this via the configured {@link Correlator}, so close
   * commits share the user's chosen id scheme instead of stamping a
   * UUID.
   */
  readonly correlation: string;
  /**
   * Page size for the safety probe's `query_streams` pagination.
   * Defaults to {@link SAFETY_PROBE_PAGE_SIZE}; production callers omit
   * it, tests set a small value to exercise the multi-page path.
   */
  readonly probe_page_size?: number;
  /**
   * Advance correlation to at least `until` (an event id) and return how
   * far it actually got.
   *
   * The safety probe can only judge events correlate has resolved (an
   * uncorrelated event has raised no mark and may not even have created its
   * subscription yet). An autoclose fires from its own, often uncorrelated,
   * trigger, so the cycle correlates the tail first; anything still above
   * the cursor is held back as pending.
   */
  readonly catch_up_correlation: (until: number) => Promise<number>;
  /**
   * Per-stream critical section, so two closers of one stream (a manual
   * close has no drain lease to exclude an autoclose) never archive the same
   * prefix, and a second full closer never mistakes the first one's
   * tombstone for an interrupted close. Identity when run in isolation.
   */
  readonly with_stream_lock?: <T>(
    stream: string,
    work: () => Promise<T>
  ) => Promise<T>;
  /**
   * Drop retired streams from correlate's in-process "already subscribed"
   * set, so a later scan re-issues `subscribe()` for them. An operator may
   * reclaim a retired subscription row while this process runs; forgetting
   * keeps the in-process view from outliving it, which would otherwise stop
   * delivery to a target named after the stream. Skipped in isolation.
   */
  readonly forget_subscribed?: (streams: string[]) => void;
};

/**
 * Scan window and pass cap for {@link catch_up_correlation}. Bounded, so a
 * close behind a large backlog skips the stream (the documented retryable
 * outcome) rather than scanning the whole log inside an operator call.
 *
 * @internal
 */
export const CLOSE_CATCH_UP_LIMIT = 1000;
const CLOSE_CATCH_UP_PASSES = 20;

/**
 * Advance correlation until the read cursor reaches `until`, and report
 * where it landed. The safety probe cannot judge a subscription's pending
 * work over events correlate has not resolved yet.
 *
 * Stops as soon as a pass makes no progress (the log has no more to give),
 * and after {@link CLOSE_CATCH_UP_PASSES} windows.
 *
 * @internal
 */
export async function catch_up_correlation(
  cursor: { readonly checkpoint: number; arm(): void },
  correlate: (limit: number) => Promise<unknown>,
  until: number
): Promise<number> {
  for (
    let pass = 0;
    pass < CLOSE_CATCH_UP_PASSES && cursor.checkpoint < until;
    pass++
  ) {
    const before = cursor.checkpoint;
    // Force the scan: the armed flag can't say whether a tail exists.
    cursor.arm();
    await correlate(CLOSE_CATCH_UP_LIMIT);
    if (cursor.checkpoint <= before) break;
  }
  return cursor.checkpoint;
}

/**
 * Per-stream serialization for close critical sections: two closers of the
 * same stream never prune or archive concurrently, while different streams
 * proceed in parallel. One instance per Act.
 *
 * @internal
 */
export class CloseLock {
  private readonly _tails = new Map<string, Promise<unknown>>();

  /** Run `work` after every earlier close of `stream` has settled. */
  run<T>(stream: string, work: () => Promise<T>): Promise<T> {
    const prev = this._tails.get(stream) ?? Promise.resolve();
    // Chain after the previous holder however it settled, so a failed close
    // can't wedge the lock.
    const next = prev.then(work, work);
    this._tails.set(stream, next);
    // Drop the tail once settled, unless a later waiter replaced it.
    const cleanup = () => {
      if (this._tails.get(stream) === next) this._tails.delete(stream);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

/**
 * Page size for the safety probe's keyset pagination over the
 * subscriptions table. Above `query_streams`'s default `limit` of 100
 * to keep the round-trip count low while bounding per-page work.
 *
 * @internal
 */
const SAFETY_PROBE_PAGE_SIZE = 1000;

/**
 * Per-stream scan result: latest non-tombstone domain event metadata.
 * `last_event_name` is always defined — the scan filters tombstones in the
 * callback and queries without `with_snaps`, so any event reaching the
 * callback is a domain event whose name we capture alongside id/version.
 */
type StreamHead = {
  readonly max_id: number;
  readonly version: number;
  readonly last_event_name: string;
  /**
   * Set when the stream already carries a tombstone but still holds domain
   * events — a close that wrote its guard and was then interrupted before
   * truncating (a throwing archive callback, or a `truncate` that failed).
   * Carries the existing guard's event id so the retry resumes at Phase 4
   * instead of re-tombstoning (which would fail the version guard) or being
   * dropped from the scan entirely.
   */
  readonly resumed_guard?: { readonly id: number };
};

/**
 * Run the full close cycle for the given targets. Caller owns the
 * lifecycle event emission.
 *
 * Targets carrying a `before` cutoff take the **windowed** branch — a
 * pure prefix delete behind an existing snapshot (see
 * {@link run_windowed_closes}); the rest run the guarded
 * tombstone/restart pipeline below.
 *
 * @internal
 */
export async function run_close_cycle(
  targets: CloseTarget[],
  deps: CloseCycleDeps
): Promise<CloseResult> {
  // Caller (Act.close) filters empty targets; run_close_cycle assumes at
  // least one target.
  const target_map = new Map(targets.map((t) => [t.stream, t]));
  for (const t of target_map.values()) {
    if (t.before !== undefined && t.restart)
      throw new Error(
        `close: \`before\` and \`restart\` are mutually exclusive (stream "${t.stream}") — a windowed close keeps the stream live behind a real snapshot; restart reseeds it`
      );
  }
  const windowed = [...target_map.values()].filter(
    (t) => t.before !== undefined
  );
  const full = [...target_map.values()].filter((t) => t.before === undefined);
  const skipped: string[] = [];
  const windowed_result = windowed.length
    ? await run_windowed_closes(windowed, deps, skipped)
    : new Map();
  if (!full.length) return { truncated: windowed_result, skipped };
  const truncated = await with_stream_locks(
    full.map((t) => t.stream),
    deps,
    () => run_full_closes(full, target_map, deps, skipped)
  );
  // A tombstone seed retired the stream; a snapshot seed restarted it.
  const retired = [...truncated.entries()]
    .filter(([, r]) => r.committed.name === TOMBSTONE_EVENT)
    .map(([stream]) => stream);
  if (retired.length) deps.forget_subscribed?.(retired);
  for (const [stream, entry] of windowed_result) truncated.set(stream, entry);
  return { truncated, skipped };
}

/**
 * Run `work` holding the per-stream close lock of every stream in
 * `streams`. Locks are taken in sorted order, so two closers whose batches
 * share streams in a different order cannot each hold one and wait on the
 * other.
 */
function with_stream_locks<T>(
  streams: string[],
  deps: CloseCycleDeps,
  work: () => Promise<T>
): Promise<T> {
  const with_lock = deps.with_stream_lock ?? ((_stream, w) => w());
  return [...streams]
    .sort()
    .reduceRight<() => Promise<T>>(
      (inner, stream) => () => with_lock(stream, inner),
      work
    )();
}

/**
 * The guarded tombstone/restart pipeline (Phases 1-6), run while holding
 * every target stream's close lock.
 */
async function run_full_closes(
  full: CloseTarget[],
  target_map: Map<string, CloseTarget>,
  deps: CloseCycleDeps,
  skipped: string[]
): Promise<CloseResult["truncated"]> {
  const none: CloseResult["truncated"] = new Map();
  const streams = full.map((t) => t.stream);

  // 1. Scan: find the latest non-tombstone event per stream
  const stream_info = await scan_stream_heads(streams);

  // 1b. A restart target whose state has sensitive fields can't be seeded
  // (an actorless load would redact them; a privileged one would put
  // plaintext where `forget` can't reach), so it is skipped, untouched,
  // before anything is written.
  for (const target of full) {
    if (!target.restart) continue;
    const info = stream_info.get(target.stream);
    if (!info) continue;
    const owner = deps.event_to_state.get(info.last_event_name);
    if (owner?.pii_aware) {
      deps.logger.error(
        `Refusing to close "${target.stream}" with restart: state "${owner.name}" carries sensitive fields, so a restart seed would persist redacted values while deleting the originals. Close it without restart to retire the stream, or leave it open.`
      );
      skipped.push(target.stream);
      stream_info.delete(target.stream);
    }
  }

  // 2. Partition: skip streams with pending reactions in flight
  const safe = await partition_by_safety(
    stream_info,
    deps.reactive_events_size,
    skipped,
    deps.probe_page_size ?? SAFETY_PROBE_PAGE_SIZE,
    deps.catch_up_correlation
  );
  if (!safe.length) return none;

  // 3. Guard: commit a tombstone with expectedVersion per safe stream.
  // Correlation comes from the orchestrator's configured correlator so
  // close commits share the app's id scheme.
  const { guarded, guard_events } = await guard_with_tombstones(
    safe,
    stream_info,
    deps.correlation,
    deps.tombstone,
    skipped
  );
  if (!guarded.length) return none;

  // 4. Seed: load final state for restart targets through the owning state
  const seed_states = await load_restart_seeds(
    guarded,
    target_map,
    stream_info,
    deps.event_to_state,
    deps.load,
    deps.logger
  );

  // 5. Archive: user-provided per-stream callback while guarded
  await run_archive_callbacks(guarded, target_map);

  // 5b. Re-check: truncate only streams whose head is still this close's
  // guard. The lock above serializes closers in this process; a closer in
  // another process can still resume our guard, finish first, and reseed
  // the stream, after which a commit can land on it. Truncating then would
  // delete that accepted commit.
  const still_guarded = await heads_still_guarded(
    guarded,
    guard_events,
    skipped
  );
  if (!still_guarded.length) return none;

  // 6. Truncate + seed: atomic per-store transaction
  return truncate_and_warm_cache(
    still_guarded,
    seed_states,
    guard_events,
    deps.correlation
  );
}

// ---------------------------------------------------------------------------
// Windowed branch — prune the prefix behind an existing snapshot
// ---------------------------------------------------------------------------

/**
 * Run the windowed closes: probe the min consumer watermark per stream
 * (the `max_id` cap that keeps the boundary at/below what the laggiest
 * consumer has read), run archive callbacks against the cutoff, then
 * hand the boundary targets to {@link Store.truncate}.
 *
 * No tombstone guard and no cache touch — the cutoff is always in the
 * past, so a concurrently-written snapshot (`created = now`) can never
 * become the boundary: once the cutoff is fixed the boundary snapshot is
 * fixed, and the prefix below it is immutable. Concurrent appends land
 * at the head, above the boundary. Current state is unchanged, so the
 * cache stays warm. Streams the store skips (no qualifying snapshot)
 * are reported in `skipped`.
 *
 * @internal
 */
async function run_windowed_closes(
  windowed: CloseTarget[],
  deps: CloseCycleDeps,
  skipped: string[]
): Promise<CloseResult["truncated"]> {
  // 1. Safety probe: how far may each stream be pruned (skipped when the
  // app has no reactions). A consumer with pending work caps at its
  // watermark; a caught-up one caps at the correlate checkpoint, since a
  // reaction to only some event types sits below the head with nothing
  // pending. Catching up first makes that cap as high as it can be.
  const checkpoint =
    deps.reactive_events_size > 0
      ? await deps.catch_up_correlation(Number.MAX_SAFE_INTEGER)
      : -1;
  const min_at =
    deps.reactive_events_size > 0
      ? await probe_min_watermarks(
          windowed.map((t) => t.stream),
          deps.probe_page_size ?? SAFETY_PROBE_PAGE_SIZE,
          checkpoint
        )
      : new Map<string, number>();

  // 2 + 3. Per stream, under its lock: archive only when the prune would
  // delete a prefix, then truncate. The lock plus that check make the
  // archive fire at most once per pruned range.
  const with_lock = deps.with_stream_lock ?? ((_stream, work) => work());
  const truncated: CloseResult["truncated"] = new Map();
  for (const t of windowed) {
    const entry = await with_lock(t.stream, async () => {
      const max_id = min_at.get(t.stream);
      // Boundary probe: will a windowed truncate prune anything? The
      // store deletes events with `id < boundary.id`, where `boundary`
      // is the latest `__snapshot__` with `created < before` (and, when
      // capped, `id <= max_id`). No such prefix ⇒ archive is skipped and
      // the stream is reported skipped, exactly as a no-op truncate would.
      if (!(await windowed_prune_pending(t.stream, t.before!, max_id)))
        return undefined;
      // Archive: user callback against the cutoff, run while the prefix
      // is still present. Sequential/fail-fast: a throw propagates to the
      // caller and leaves the stream un-truncated (no data loss).
      if (t.archive) await t.archive();
      // Boundary truncate: atomic per-store transaction; no seed.
      const result = await store().truncate([
        { stream: t.stream, before: t.before!, max_id },
      ]);
      return result.get(t.stream);
    });
    if (entry) truncated.set(t.stream, entry);
    else skipped.push(t.stream);
  }
  return truncated;
}

/**
 * Read-only probe: would a windowed truncate of `stream` at `before`
 * (optionally capped at `max_id`) delete a prefix? Mirrors the store's
 * boundary rule — the latest `__snapshot__` with `created < before` and,
 * when capped, `id <= max_id` — then reports whether any event sorts
 * strictly below that boundary. False when no snapshot qualifies (a
 * no-op truncate) or when the boundary is already the earliest event
 * (the prefix was pruned by a prior closer). This is the guard that
 * makes the windowed archive fire at most once per pruned range.
 *
 * @internal
 */
async function windowed_prune_pending(
  stream: string,
  before: Date,
  max_id: number | undefined
): Promise<boolean> {
  let boundary_id: number | undefined;
  let min_id: number | undefined;
  await store().query(
    (event) => {
      if (min_id === undefined || event.id < min_id) min_id = event.id;
      if (
        event.name === SNAP_EVENT &&
        event.created < before &&
        (max_id === undefined || event.id <= max_id) &&
        (boundary_id === undefined || event.id > boundary_id)
      )
        boundary_id = event.id;
    },
    { stream, stream_exact: true, with_snaps: true, after: -1 }
  );
  // No qualifying snapshot → nothing to prune behind. Otherwise a prune
  // is pending only when some event sorts below the boundary.
  return boundary_id !== undefined && min_id! < boundary_id;
}

/**
 * Min subscription watermark per target stream — the read-only probe
 * backing the windowed close's `max_id` cap. Pagination and source
 * matching mirror {@link partition_by_safety}; instead of flagging
 * pending streams it folds `min(at)` per stream. Streams with no
 * matching subscriptions are absent (no cap).
 *
 * @internal
 */
async function probe_min_watermarks(
  streams: string[],
  page_size: number,
  checkpoint: number
): Promise<Map<string, number>> {
  const min_at = new Map<string, number>();
  const source_regex = new Map<string, RegExp>();
  const get_regex = (source: string): RegExp => {
    let re = source_regex.get(source);
    if (!re) {
      re = new RegExp(source);
      source_regex.set(source, re);
    }
    return re;
  };

  let after: string | undefined;
  for (;;) {
    let last: string | undefined;
    const { count } = await store().query_streams(
      (position) => {
        last = position.stream;
        const source_re = position.source
          ? get_regex(position.source)
          : undefined;
        // Pending work caps at the watermark; caught up caps at the
        // checkpoint; an unmarked row keeps the conservative watermark.
        const pending =
          position.correlated_at === undefined ||
          position.at < position.correlated_at;
        const cap = pending ? position.at : Math.max(position.at, checkpoint);
        for (const stream of streams) {
          if (!source_re || source_re.test(stream)) {
            const prev = min_at.get(stream);
            if (prev === undefined || cap < prev) min_at.set(stream, cap);
          }
        }
      },
      { after, limit: page_size, source_matches: streams }
    );
    if (count < page_size) break;
    after = last;
  }
  return min_at;
}

// ---------------------------------------------------------------------------
// Phase 1 — scan stream heads
// ---------------------------------------------------------------------------

async function scan_stream_heads(
  streams: string[]
): Promise<Map<string, StreamHead>> {
  // query_stats returns the latest non-snap event per stream (heads-only
  // cheap path, indexed). Streams whose latest non-snap event is a tombstone
  // are filtered out in the loop — we don't want to re-tombstone an
  // already-closed stream. Streams with no events (or only snap/tombstone
  // events filtered out) are absent from the result map entirely.
  const stats = await store().query_stats(streams, {
    exclude: [SNAP_EVENT],
  });
  // Domain head, markers excluded. A stream absent here has no domain
  // events left, so a previous close ran to completion and there is
  // nothing to do. A stream present here whose `stats` head is a tombstone
  // was guarded and then interrupted — it must be resumed, not skipped.
  // `last_event_name` also has to come from this pass: the
  // restart-seed owner lookup needs the domain event, not the marker.
  const domain_heads = await store().query_stats(streams, {
    exclude: [SNAP_EVENT, TOMBSTONE_EVENT],
  });
  // The tombstone must expect the stream's real head version, which a
  // trailing `__snapshot__` raises by one. Everything else uses the domain
  // head, so the true head gets its own heads-only read.
  const true_heads = await store().query_stats(streams, {});
  const out = new Map<string, StreamHead>();
  for (const [stream, { head }] of domain_heads) {
    const marker_head = stats.get(stream)?.head;
    const interrupted = marker_head?.name === TOMBSTONE_EVENT;
    out.set(stream, {
      max_id: head.id,
      version: true_heads.get(stream)!.head.version,
      last_event_name: head.name as string,
      ...(interrupted ? { resumed_guard: { id: marker_head.id } } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 2 — partition by safety
// ---------------------------------------------------------------------------

async function partition_by_safety(
  stream_info: Map<string, StreamHead>,
  reactive_events_size: number,
  skipped: string[],
  page_size: number,
  catch_up_correlation: (until: number) => Promise<number>
): Promise<string[]> {
  if (reactive_events_size === 0) return [...stream_info.keys()];

  // Correlate the tail first (see `catch_up_correlation`); anything still
  // above the cursor afterwards is held back.
  let needed = -1;
  for (const info of stream_info.values())
    needed = Math.max(needed, info.max_id);
  const checkpoint = await catch_up_correlation(needed);
  const uncorrelated = new Set<string>();
  for (const [stream, info] of stream_info) {
    if (checkpoint < info.max_id) uncorrelated.add(stream);
  }

  // Read-only. A subscription's `source` is matched as a regex either way
  // (a literal matches itself); over-matching only widens the pending set,
  // the safe direction. Compiled patterns are cached.
  const pending_set = new Set<string>();
  const source_regex = new Map<string, RegExp>();
  const get_regex = (source: string): RegExp => {
    let re = source_regex.get(source);
    if (!re) {
      re = new RegExp(source);
      source_regex.set(source, re);
    }
    return re;
  };

  // `source_matches` narrows the probe server-side to subscriptions that
  // could consume from a stream we're closing — a best-effort hint, so
  // the per-position source/target re-check below still runs and keeps
  // the result correct even when a store returns a superset.
  const targets = [...stream_info.keys()];

  // Keyset-paginate the (narrowed) subscriptions on the `after` cursor —
  // `query_streams` caps each call at `limit` rows, so every page is
  // inspected until a short page signals the last one. A lagging reaction
  // marks its close target pending regardless of how far its subscription
  // sorts past the first page.
  let after: string | undefined;
  for (;;) {
    let last: string | undefined;
    const { count } = await store().query_streams(
      (position) => {
        last = position.stream;
        const source_re = position.source
          ? get_regex(position.source)
          : undefined;
        // Pending means what `claim` means: a mark above the watermark. An
        // unmarked row has nothing to wait for; the catch-up above has landed
        // every mark that was owed.
        const has_work =
          position.correlated_at !== undefined &&
          position.at < position.correlated_at;
        if (!has_work) return;
        for (const [stream, info] of stream_info) {
          if (
            (!source_re || source_re.test(stream)) &&
            position.at < info.max_id
          ) {
            pending_set.add(stream);
          }
        }
      },
      { after, limit: page_size, source_matches: targets }
    );
    if (count < page_size) break;
    after = last;
  }

  const safe: string[] = [];
  for (const [stream] of stream_info) {
    if (pending_set.has(stream) || uncorrelated.has(stream))
      skipped.push(stream);
    else safe.push(stream);
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Phase 3 — guard with tombstones
// ---------------------------------------------------------------------------

async function guard_with_tombstones(
  safe: string[],
  stream_info: Map<string, StreamHead>,
  correlation: string,
  tombstone: EsOps["tombstone"],
  skipped: string[]
): Promise<{
  guarded: string[];
  guard_events: Map<string, { id: number; stream: string }>;
}> {
  const guarded: string[] = [];
  const guard_events = new Map<string, { id: number; stream: string }>();
  await Promise.all(
    safe.map(async (stream) => {
      const info = stream_info.get(stream)!;
      if (info.resumed_guard) {
        // Guard already written by the interrupted run — reuse it rather
        // than re-tombstoning (the version guard would reject it anyway).
        guarded.push(stream);
        guard_events.set(stream, { id: info.resumed_guard.id, stream });
        return;
      }
      const committed = await tombstone(stream, info.version, correlation);
      if (committed) {
        guarded.push(stream);
        guard_events.set(stream, { id: committed.id, stream });
      } else {
        // ConcurrencyError → another writer beat the guard
        skipped.push(stream);
      }
    })
  );
  return { guarded, guard_events };
}

// ---------------------------------------------------------------------------
// Phase 4 — load restart seeds
// ---------------------------------------------------------------------------

async function load_restart_seeds(
  guarded: string[],
  target_map: Map<string, CloseTarget>,
  stream_info: Map<string, StreamHead>,
  event_to_state: ReadonlyMap<string, State<any, any, any>>,
  load: EsOps["load"],
  logger: Logger
): Promise<Map<string, Schema>> {
  const seed_states = new Map<string, Schema>();
  await Promise.all(
    guarded
      .filter((s) => target_map.get(s)?.restart)
      .map(async (stream) => {
        // stream_info entry is guaranteed (guarded ⊆ stream_info.keys()).
        const last_event_name = stream_info.get(stream)!.last_event_name;
        const owner_state = event_to_state.get(last_event_name);
        if (!owner_state) {
          // No registered state owns the stream's events (deleted state,
          // schema versioning gone wrong, etc.). Tombstone instead of
          // seeding a corrupted snapshot.
          logger.error(
            `Cannot seed restart for "${stream}": no registered state owns event "${last_event_name}". Stream will be tombstoned instead.`
          );
          return;
        }
        const snap = await load(owner_state, { stream });
        seed_states.set(stream, snap.state as Schema);
      })
  );
  return seed_states;
}

// ---------------------------------------------------------------------------
// Phase 5 — archive callbacks
// ---------------------------------------------------------------------------

async function run_archive_callbacks(
  guarded: string[],
  target_map: Map<string, CloseTarget>
): Promise<void> {
  // Sequential — user callbacks may share resources (S3 client, etc.) and
  // a failure should propagate to the caller without leaving partial state.
  for (const stream of guarded) {
    const archive_fn = target_map.get(stream)?.archive;
    if (archive_fn) await archive_fn();
  }
}

// ---------------------------------------------------------------------------
// Phase 5b — confirm the guard is still the head
// ---------------------------------------------------------------------------

async function heads_still_guarded(
  guarded: string[],
  guard_events: Map<string, { id: number; stream: string }>,
  skipped: string[]
): Promise<string[]> {
  // True heads, markers included: the guard is a tombstone, and a reseed
  // by another closer is a snapshot.
  const heads = await store().query_stats(guarded, {});
  return guarded.filter((stream) => {
    if (heads.get(stream)?.head.id === guard_events.get(stream)!.id)
      return true;
    skipped.push(stream);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Phase 6 — atomic truncate + cache warm
// ---------------------------------------------------------------------------

async function truncate_and_warm_cache(
  guarded: string[],
  seed_states: Map<string, Schema>,
  guard_events: Map<string, { id: number; stream: string }>,
  correlation: string
): Promise<CloseResult["truncated"]> {
  const trunc_targets = guarded.map((stream) => {
    const snapshot = seed_states.get(stream);
    const guard = guard_events.get(stream)!;
    return {
      stream,
      snapshot,
      meta: {
        correlation,
        causation: {
          event: { id: guard.id, name: TOMBSTONE_EVENT, stream: guard.stream },
        },
      },
    };
  });
  const truncated = await store().truncate(trunc_targets);

  // Cache invalidate / warm — use real event IDs from committed events
  await Promise.all(
    guarded.map(async (stream) => {
      const entry = truncated.get(stream);
      const state = seed_states.get(stream);
      if (state && entry) {
        await cache().set(stream, {
          stream,
          state,
          version: entry.committed.version,
          event_id: entry.committed.id,
          patches: 0,
          snaps: 1,
        });
      } else {
        await cache().invalidate(stream);
      }
    })
  );

  return truncated;
}
