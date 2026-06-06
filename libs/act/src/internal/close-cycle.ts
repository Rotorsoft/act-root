/**
 * @module close-cycle
 * @category Internal
 *
 * Pure orchestration of the close-the-books flow: scan stream heads,
 * partition by reaction safety, guard with tombstones, optionally seed
 * restart state, run user archive callbacks, atomically truncate, and
 * update the cache.
 *
 * The Act orchestrator owns lifecycle (correlate gate, emit("closed")) and
 * the registry-derived inputs (reactive-event count, event→state map). All
 * sequential phase work between those state touches lives here.
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
};

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
};

/**
 * Run the full close cycle for the given targets. Caller owns the
 * lifecycle event emission.
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
  const streams = [...target_map.keys()];
  const skipped: string[] = [];

  // 1. Scan: find the latest non-tombstone event per stream
  const stream_info = await scan_stream_heads(streams);

  // 2. Partition: skip streams with pending reactions in flight
  const safe = await partition_by_safety(
    stream_info,
    deps.reactive_events_size,
    skipped
  );
  if (!safe.length) return { truncated: new Map(), skipped };

  // 3. Guard: commit a tombstone with expectedVersion per safe stream.
  // Correlation comes from the orchestrator's configured correlator so
  // close commits share the app's id scheme — see ACT-404.
  const { guarded, guard_events } = await guard_with_tombstones(
    safe,
    stream_info,
    deps.correlation,
    deps.tombstone,
    skipped
  );
  if (!guarded.length) return { truncated: new Map(), skipped };

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

  // 6. Truncate + seed: atomic per-store transaction
  const truncated = await truncate_and_warm_cache(
    guarded,
    seed_states,
    guard_events,
    deps.correlation
  );

  return { truncated, skipped };
}

// ---------------------------------------------------------------------------
// Phase 1 — scan stream heads
// ---------------------------------------------------------------------------

async function scan_stream_heads(
  streams: string[]
): Promise<Map<string, StreamHead>> {
  // One round trip: query_stats returns the latest non-snap event per
  // stream (heads-only cheap path, indexed). Streams whose latest non-snap
  // event is a tombstone are filtered out in the loop — we don't want to
  // re-tombstone an already-closed stream. Streams with no events (or
  // only snap/tombstone events filtered out) are absent from the result
  // map entirely.
  const stats = await store().query_stats(streams, {
    exclude: [SNAP_EVENT],
  });
  const out = new Map<string, StreamHead>();
  for (const [stream, { head }] of stats) {
    if (head.name === TOMBSTONE_EVENT) continue;
    out.set(stream, {
      max_id: head.id,
      version: head.version,
      last_event_name: head.name as string,
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
  skipped: string[]
): Promise<string[]> {
  if (reactive_events_size === 0) return [...stream_info.keys()];

  // Read-only probe: query_streams returns subscription positions without
  // leasing or mutating retry state.
  const pending_set = new Set<string>();
  await store().query_streams((position) => {
    const source_re = position.source ? RegExp(position.source) : undefined;
    for (const [stream, info] of stream_info) {
      if ((!source_re || source_re.test(stream)) && position.at < info.max_id) {
        pending_set.add(stream);
      }
    }
  });

  const safe: string[] = [];
  for (const [stream] of stream_info) {
    if (pending_set.has(stream)) skipped.push(stream);
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
        const snap = await load(owner_state, stream);
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
