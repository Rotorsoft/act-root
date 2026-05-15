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

import { cache, store, TOMBSTONE_EVENT } from "../ports.js";
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
  readonly reactiveEventsSize: number;
  readonly eventToState: ReadonlyMap<string, State<any, any, any>>;
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
 * `lastEventName` is always defined — the scan filters tombstones in the
 * callback and queries without `with_snaps`, so any event reaching the
 * callback is a domain event whose name we capture alongside id/version.
 */
type StreamHead = {
  readonly maxId: number;
  readonly version: number;
  readonly lastEventName: string;
};

/**
 * Run the full close cycle for the given targets. Caller owns the
 * lifecycle event emission.
 *
 * @internal
 */
export async function runCloseCycle(
  targets: CloseTarget[],
  deps: CloseCycleDeps
): Promise<CloseResult> {
  // Caller (Act.close) filters empty targets; runCloseCycle assumes at
  // least one target.
  const targetMap = new Map(targets.map((t) => [t.stream, t]));
  const streams = [...targetMap.keys()];
  const skipped: string[] = [];

  // 1. Scan: find the latest non-tombstone event per stream
  const streamInfo = await scanStreamHeads(streams);

  // 2. Partition: skip streams with pending reactions in flight
  const safe = await partitionBySafety(
    streamInfo,
    deps.reactiveEventsSize,
    skipped
  );
  if (!safe.length) return { truncated: new Map(), skipped };

  // 3. Guard: commit a tombstone with expectedVersion per safe stream.
  // Correlation comes from the orchestrator's configured correlator so
  // close commits share the app's id scheme — see ACT-404.
  const { guarded, guardEvents } = await guardWithTombstones(
    safe,
    streamInfo,
    deps.correlation,
    deps.tombstone,
    skipped
  );
  if (!guarded.length) return { truncated: new Map(), skipped };

  // 4. Seed: load final state for restart targets through the owning state
  const seedStates = await loadRestartSeeds(
    guarded,
    targetMap,
    streamInfo,
    deps.eventToState,
    deps.load,
    deps.logger
  );

  // 5. Archive: user-provided per-stream callback while guarded
  await runArchiveCallbacks(guarded, targetMap);

  // 6. Truncate + seed: atomic per-store transaction
  const truncated = await truncateAndWarmCache(
    guarded,
    seedStates,
    guardEvents,
    deps.correlation
  );

  return { truncated, skipped };
}

// ---------------------------------------------------------------------------
// Phase 1 — scan stream heads
// ---------------------------------------------------------------------------

async function scanStreamHeads(
  streams: string[]
): Promise<Map<string, StreamHead>> {
  const out = new Map<string, StreamHead>();
  await Promise.all(
    streams.map(async (s) => {
      let maxId = -1;
      let version = -1;
      let lastEventName = "";
      await store().query(
        (e) => {
          // backward iteration: first non-tombstone is the most recent
          // domain event. snaps are filtered server-side (no with_snaps).
          if (e.name === TOMBSTONE_EVENT || maxId !== -1) return;
          maxId = e.id;
          version = e.version;
          lastEventName = e.name;
        },
        { stream: s, stream_exact: true, backward: true, limit: 1 }
      );
      if (maxId >= 0) out.set(s, { maxId, version, lastEventName });
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Phase 2 — partition by safety
// ---------------------------------------------------------------------------

async function partitionBySafety(
  streamInfo: Map<string, StreamHead>,
  reactiveEventsSize: number,
  skipped: string[]
): Promise<string[]> {
  if (reactiveEventsSize === 0) return [...streamInfo.keys()];

  // Read-only probe: query_streams returns subscription positions without
  // leasing or mutating retry state.
  const pendingSet = new Set<string>();
  await store().query_streams((position) => {
    const sourceRe = position.source ? RegExp(position.source) : undefined;
    for (const [stream, info] of streamInfo) {
      if ((!sourceRe || sourceRe.test(stream)) && position.at < info.maxId) {
        pendingSet.add(stream);
      }
    }
  });

  const safe: string[] = [];
  for (const [stream] of streamInfo) {
    if (pendingSet.has(stream)) skipped.push(stream);
    else safe.push(stream);
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Phase 3 — guard with tombstones
// ---------------------------------------------------------------------------

async function guardWithTombstones(
  safe: string[],
  streamInfo: Map<string, StreamHead>,
  correlation: string,
  tombstone: EsOps["tombstone"],
  skipped: string[]
): Promise<{
  guarded: string[];
  guardEvents: Map<string, { id: number; stream: string }>;
}> {
  const guarded: string[] = [];
  const guardEvents = new Map<string, { id: number; stream: string }>();
  await Promise.all(
    safe.map(async (stream) => {
      const info = streamInfo.get(stream)!;
      const committed = await tombstone(stream, info.version, correlation);
      if (committed) {
        guarded.push(stream);
        guardEvents.set(stream, { id: committed.id, stream });
      } else {
        // ConcurrencyError → another writer beat the guard
        skipped.push(stream);
      }
    })
  );
  return { guarded, guardEvents };
}

// ---------------------------------------------------------------------------
// Phase 4 — load restart seeds
// ---------------------------------------------------------------------------

async function loadRestartSeeds(
  guarded: string[],
  targetMap: Map<string, CloseTarget>,
  streamInfo: Map<string, StreamHead>,
  eventToState: ReadonlyMap<string, State<any, any, any>>,
  load: EsOps["load"],
  logger: Logger
): Promise<Map<string, Schema>> {
  const seedStates = new Map<string, Schema>();
  await Promise.all(
    guarded
      .filter((s) => targetMap.get(s)?.restart)
      .map(async (stream) => {
        // streamInfo entry is guaranteed (guarded ⊆ streamInfo.keys()).
        const lastEventName = streamInfo.get(stream)!.lastEventName;
        const ownerState = eventToState.get(lastEventName);
        if (!ownerState) {
          // No registered state owns the stream's events (deleted state,
          // schema versioning gone wrong, etc.). Tombstone instead of
          // seeding a corrupted snapshot.
          logger.error(
            `Cannot seed restart for "${stream}": no registered state owns event "${lastEventName}". Stream will be tombstoned instead.`
          );
          return;
        }
        const snap = await load(ownerState, stream);
        seedStates.set(stream, snap.state as Schema);
      })
  );
  return seedStates;
}

// ---------------------------------------------------------------------------
// Phase 5 — archive callbacks
// ---------------------------------------------------------------------------

async function runArchiveCallbacks(
  guarded: string[],
  targetMap: Map<string, CloseTarget>
): Promise<void> {
  // Sequential — user callbacks may share resources (S3 client, etc.) and
  // a failure should propagate to the caller without leaving partial state.
  for (const stream of guarded) {
    const archiveFn = targetMap.get(stream)?.archive;
    if (archiveFn) await archiveFn();
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — atomic truncate + cache warm
// ---------------------------------------------------------------------------

async function truncateAndWarmCache(
  guarded: string[],
  seedStates: Map<string, Schema>,
  guardEvents: Map<string, { id: number; stream: string }>,
  correlation: string
): Promise<CloseResult["truncated"]> {
  const truncTargets = guarded.map((stream) => {
    const snapshot = seedStates.get(stream);
    const guard = guardEvents.get(stream)!;
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
  const truncated = await store().truncate(truncTargets);

  // Cache invalidate / warm — use real event IDs from committed events
  await Promise.all(
    guarded.map(async (stream) => {
      const entry = truncated.get(stream);
      const state = seedStates.get(stream);
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
