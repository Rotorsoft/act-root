/**
 * @module event-sourcing
 * @category Internal
 *
 * Pure event-sourcing primitives: `snap` persists state checkpoints, `load`
 * reconstructs state by replaying events through reducers, and `action`
 * validates an action, runs invariants, emits events, and commits them
 * atomically. `tombstone` commits the close-the-books guard with optimistic
 * concurrency.
 *
 * These are the bare implementations — observability is layered on top in
 * {@link "tracing"} and wired by the orchestrator at construction time.
 * No tracing imports here, no module-level mutable state.
 *
 * @internal
 */

import { patch } from "@rotorsoft/act-patch";
import { cache, log, SNAP_EVENT, store, TOMBSTONE_EVENT } from "../ports.js";
import {
  ConcurrencyError,
  InvariantError,
  StreamClosedError,
} from "../types/errors.js";
import type {
  Committed,
  Correlator,
  DoOptions,
  Emitted,
  EventMeta,
  EventSource,
  LoadTarget,
  ScanOptions,
  ScanResult,
  Schema,
  Schemas,
  Snapshot,
  State,
  Target,
} from "../types/index.js";
import { sleep, validate } from "../utils.js";
import { compute_backoff_delay } from "./backoff.js";
import { default_correlator } from "./correlator.js";

/**
 * Default per-batch row count for the {@link scan} pagination loop
 * (ACT-1133). Callers override via {@link ScanOptions.batch_size}.
 *
 * @internal
 */
const DEFAULT_BATCH = 500;

/**
 * Internal action signature seen by the orchestrator — the {@link Correlator}
 * is bound at `build_es` time, so callers don't pass it through.
 *
 * @internal
 */
export type BoundAction = <
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TKey extends keyof TActions,
>(
  me: State<TState, TEvents, TActions>,
  action: TKey,
  target: Target,
  payload: Readonly<TActions[TKey]>,
  options?: DoOptions<TEvents>
) => Promise<Snapshot<TState, TEvents>[]>;

/** @internal */
export interface EsOps {
  snap: typeof snap;
  load: typeof load;
  action: BoundAction;
  tombstone: typeof tombstone;
}

/**
 * Event sourcing utilities for snapshotting, loading, and committing actions/events.
 * Used internally by Act and state machines.
 */

/**
 * Saves a snapshot of the state to the store.
 *
 * Snapshots are used to optimize state reconstruction for aggregates with long event streams.
 *
 * @template TState The type of state
 * @template TEvents The type of events
 * @param snapshot The snapshot to save
 * @returns Promise that resolves when the snapshot is saved
 *
 * @example
 * await snap(snapshot);
 */
export async function snap<TState extends Schema, TEvents extends Schemas>(
  snapshot: Snapshot<TState, TEvents>
): Promise<void> {
  try {
    const { id, stream, name, meta, version } = snapshot.event!;
    await store().commit(
      stream,
      [{ name: SNAP_EVENT, data: snapshot.state }],
      {
        correlation: meta.correlation,
        causation: { event: { id, name: name as string, stream } },
      },
      version // IMPORTANT! - state events are committed right after the snapshot event
    );
  } catch (error) {
    log().error(error);
  }
}

/**
 * Commits a tombstone event with optimistic concurrency, returning the
 * committed record on success or `undefined` if the stream moved past
 * `expectedVersion` (concurrent write detected). Other store errors
 * propagate.
 *
 * Used by `close()` to guard a stream while archive/truncate runs:
 * subsequent `action()` calls see the tombstone at head and reject with
 * {@link StreamClosedError} until the close completes.
 *
 * @internal
 */
export async function tombstone(
  stream: string,
  expectedVersion: number,
  correlation: string
): Promise<Committed<Schemas, keyof Schemas> | undefined> {
  try {
    const [committed] = await store().commit(
      stream,
      [{ name: TOMBSTONE_EVENT, data: {} }],
      { correlation, causation: {} },
      expectedVersion
    );
    return committed;
  } catch (error) {
    if (error instanceof ConcurrencyError) return undefined;
    throw error;
  }
}

/**
 * Per-event blocker check. Categories:
 *
 * - **Negative `version`** — versions are unsigned in the framework
 *   contract.
 * - **Malformed `created`** — `event.created` must be a valid Date
 *   instance. Restore sources stream parsed events; the orchestrator
 *   trusts the caller's iterator did the parsing.
 *
 * Cross-event invariants (duplicate ids, per-stream version gaps) are
 * not the validator's job — DB `UNIQUE(stream, version)` catches
 * duplicates at commit time, and gap detection is a caller-specific
 * policy (partial backups intentionally have gaps).
 *
 * Extension point: per-event Zod schema validation against the active
 * registry will land here — the source-side check is the right layer
 * for it (catches malformed payloads before the sink transaction
 * opens), and adding it keeps the per-event blocker contract in one
 * place.
 *
 * @internal
 */
function is_valid(event: Committed<Schemas, keyof Schemas>): boolean {
  if (event.version < 0) return false;
  if (!(event.created instanceof Date) || Number.isNaN(event.created.getTime()))
    return false;
  return true;
}

/**
 * Scan a restore source event by event. Owns pagination, validation,
 * the `drop_snapshots` filter, the `on_progress` callback, and the
 * causation remap; adapters supply only the per-event insert
 * `callback` via the driver pattern (see {@link Store.restore}).
 *
 * Walks the source in chunks of {@link BATCH} via the existing
 * `EventSource.query` interface — `limit: BATCH` and `after: <last
 * id seen>` per batch (ACT-1133). Stores that respect `limit`
 * (`PostgresStore`) return at most `BATCH` rows per call; sources
 * that ignore the filter (`CsvFile`) stream everything in one call
 * and the loop exits after the first batch when `got > BATCH`. The
 * source's own per-event `await Promise.resolve(callback(event))`
 * provides backpressure — no separate mailbox needed.
 *
 * Throws on the first invalid event (negative version, malformed
 * `created`) with the running index in the message.
 *
 * Returns the partial {@link ScanResult} (without `duration_ms`)
 * — {@link Act.restore} wraps the call with its own timing so the
 * duration covers transaction setup and commit, not just iteration.
 *
 * @internal
 */
export async function scan(
  source: EventSource,
  opts: ScanOptions = {},
  callback?: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
): Promise<Omit<ScanResult, "duration_ms">> {
  const {
    drop_snapshots = false,
    drop_closed_streams = false,
    on_progress,
    event_migrations,
    stream_rename,
  } = opts;
  const limit = opts.batch_size ?? DEFAULT_BATCH;
  const id_map = new Map<number, number>();
  let kept = 0;
  let dropped_snaps = 0;
  let dropped_closed = 0;
  let migrated_count = 0;
  let processed = 0;
  let at: number | undefined;

  // Pre-pass for `drop_closed_streams` (ACT-1126). Walk the source
  // once with a tombstone-name filter to collect closed streams. PG
  // honors the filter and only the tombstone events come back; sources
  // that ignore the filter (CsvFile) stream all events but we cheaply
  // pick out the tombstones in the callback. Either way the cost is
  // one extra walk, paid only when the operator opts in.
  const closed_streams = new Set<string>();
  if (drop_closed_streams) {
    await source.query<Schemas>(
      (e) => {
        if (e.name === TOMBSTONE_EVENT) closed_streams.add(e.stream);
      },
      { names: [TOMBSTONE_EVENT] }
    );
  }

  // Probe the source for the highest id once up front. On indexed
  // stores (PostgresStore, SqliteStore) `{ backward: true, limit: 1 }`
  // is an index-only seek — O(1) on the (id) index. Sources that
  // ignore the filter (CsvFile) stream every event from this one
  // call; we detect that via the returned count and leave max_id
  // undefined rather than reporting an unreliable value.
  let max_id: number | undefined;
  const probed = await source.query<Schemas>(
    (e) => {
      max_id = e.id;
    },
    { backward: true, limit: 1 }
  );
  if (probed !== 1) max_id = undefined;

  while (true) {
    let got = 0;
    let id: number | undefined;

    await source.query<Schemas>(
      async (event) => {
        got++;
        id = event.id;
        processed++;
        if (!is_valid(event))
          throw new Error(`Invalid event at index ${processed}`);
        if (on_progress) on_progress({ processed, id: event.id, max_id });
        if (drop_snapshots && event.name === SNAP_EVENT) {
          dropped_snaps++;
          return;
        }
        if (
          closed_streams.has(event.stream) &&
          event.name !== TOMBSTONE_EVENT
        ) {
          // Drop pre-close events but KEEP the tombstone — it's what
          // makes the stream "closed" in the rebuilt store. Without
          // it, a future `app.do(...)` against this stream name would
          // succeed because nothing gates it.
          dropped_closed++;
          return;
        }
        // Migration overlay (ACT-1126): rename + schema-guarded data
        // transform, then optional stream rename. Applied BEFORE the
        // causation remap so the id_map (keyed by source id) stays
        // valid and migrated events land at the new name/data with
        // their causation chains intact.
        let migrated: typeof event = event;
        const migration = event_migrations?.[event.name as string];
        if (migration) {
          const old_data = migration.from_schema.parse(event.data);
          const new_data = migration.migrate(old_data);
          migration.to_schema.parse(new_data);
          migrated = {
            ...event,
            name: migration.to as typeof event.name,
            // biome-ignore lint/suspicious/noExplicitAny: migration target shape is caller-defined
            data: new_data as any,
          };
          migrated_count++;
        }
        if (stream_rename) {
          const renamed = stream_rename(migrated.stream);
          if (renamed !== migrated.stream)
            migrated = { ...migrated, stream: renamed };
        }
        if (!callback) {
          kept++;
          return;
        }
        // Causation remap — rewrite `meta.causation.event.id` to the
        // new id space if the source pointed at an earlier event's
        // old id.
        let remapped = migrated;
        const caused_by = migrated.meta.causation.event?.id;
        if (caused_by !== undefined) {
          const new_caused_by = id_map.get(caused_by);
          if (new_caused_by !== undefined && new_caused_by !== caused_by) {
            remapped = {
              ...event,
              meta: {
                ...event.meta,
                causation: {
                  ...event.meta.causation,
                  event: { ...event.meta.causation.event!, id: new_caused_by },
                },
              },
            };
          }
        }
        const new_id = await callback(remapped);
        id_map.set(event.id, new_id);
        kept++;
      },
      { after: at, limit }
    );

    // Termination:
    //   - got < batch: source honored limit but ran out (also covers
    //     got === 0 — past-the-end on a paginating source).
    //   - got > batch: source ignored the filter (CsvFile-style). It
    //     streamed everything in one call; nothing left to ask for.
    //   Otherwise (got === batch): more events may exist; bump and continue.
    if (got !== limit) break;
    at = id;
  }

  return {
    kept,
    migrated: migrated_count,
    dropped: {
      closed_streams: dropped_closed,
      snapshots: dropped_snaps,
    },
  };
}

/**
 * Loads a snapshot of the state from the store by replaying events and applying patches.
 *
 * First checks the cache for a checkpoint, then queries the store for events
 * committed after the cached position. On cache miss, replays from the store
 * (using snapshots if available to avoid full replay).
 *
 * @template TState The type of state
 * @template TEvents The type of events
 * @template TActions The type of actions
 * @param me The state machine definition.
 * @param stream The stream (instance) to load
 * @param callback (Optional) Callback to receive the loaded snapshot as it is built
 * @param asOf (Optional) Time-travel cursor; bypasses the cache.
 * @param actor (Optional) Passed through to the state's `view` delegate
 *   when constructing the snapshot.event — semantics are the state's to
 *   define (see {@link state}).
 * @returns The snapshot of the loaded state
 *
 * @example
 * const snapshot = await load(Counter, "counter1");
 */
export async function load<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
>(
  me: State<TState, TEvents, TActions>,
  target: LoadTarget,
  callback?: (snapshot: Snapshot<TState, TEvents>) => void
): Promise<Snapshot<TState, TEvents>> {
  const { stream, actor, asOf } = target;
  const time_travel =
    !!asOf && Object.values(asOf).some((v) => v !== undefined);
  const cached = time_travel ? undefined : await cache().get<TState>(stream);
  const cache_hit = !!cached;
  let state = cached?.state ?? (me.init ? me.init() : ({} as TState));
  let patches = cached?.patches ?? 0;
  let snaps = cached?.snaps ?? 0;
  // replayed counts events processed by THIS load only (snap or patch);
  // distinct from `patches` (the snap-distance accumulator carried over
  // from the cache).
  let replayed = 0;
  let event: Committed<TEvents, keyof TEvents> | undefined;

  await store().query<TEvents>(
    (raw) => {
      event = me.view(raw, actor);
      if (event.name === SNAP_EVENT) {
        state = event.data as TState;
        snaps++;
        patches = 0;
        replayed++;
      } else if (me.patch[event.name]) {
        state = patch(state, me.patch[event.name](event, state));
        patches++;
        replayed++;
      } else if (event.name !== TOMBSTONE_EVENT) {
        // Unknown event — not in this state's reducer map. Causes:
        // deleted/renamed event in a versioned schema, load() called with
        // the wrong state, or stream contamination. Skipping silently
        // would corrupt replay; warn so the operator can investigate.
        log().warn(
          `Skipping unknown event "${String(event.name)}" on stream "${stream}" (id=${event.id}) — no reducer in state "${me.name}"`
        );
      }
      callback?.({
        event,
        state,
        version: event.version,
        patches,
        snaps,
        cache_hit,
        replayed,
      });
    },
    {
      stream,
      stream_exact: true,
      ...(cached ? { after: cached.event_id } : { with_snaps: true, ...asOf }),
    }
  );

  // Populate the cache when this load actually processed events. Without
  // this, read-heavy paths (UI loops calling load() many times between
  // commits) miss the cache forever — only action() would ever warm it.
  // No race-protection re-check needed: the cache is a state checkpoint
  // at (version, event_id), and any subsequent load queries past
  // event_id, picks up missed events, and replays — so an "older" cache
  // write from a concurrent slower load is self-correcting on next access.
  // Time-travel loads bypass cache entirely and skip this too.
  if (replayed > 0 && !time_travel && event && !me.pii_aware) {
    await cache().set(stream, {
      state,
      version: event.version,
      event_id: event.id,
      patches,
      snaps,
    });
  }

  return {
    event,
    state,
    version: event?.version ?? cached?.version ?? -1,
    patches,
    snaps,
    cache_hit,
    replayed,
  };
}

/**
 * Executes an action and emits an event to be committed by the store.
 *
 * Validates the action, applies business invariants, emits events, and
 * commits them to the event store. When the action's
 * {@link ActionOptions} declare a retry budget, the orchestrator owns
 * the loop on {@link ConcurrencyError}: cache is invalidated, optional
 * `backoff` delay is applied, and the action re-runs from `load`. Any
 * other error rethrows immediately and does not consume the budget.
 *
 * Reactions skip optimistic concurrency (commit below passes
 * `undefined` as `expectedVersion` when `reactingTo` is set), so
 * `ConcurrencyError` cannot fire on the reaction-driven path — the
 * loop is naturally a no-op there.
 *
 * @template TState The type of state
 * @template TEvents The type of events
 * @template TActions The type of action_schemas
 * @template TKey The type of action to execute
 * @param me The state machine definition
 * @param action The action to execute
 * @param target The target (stream, actor, etc.)
 * @param payload The payload of the action
 * @param options Per-call dispatch options ({@link DoOptions}) —
 *   `reactingTo` to thread correlation, `skipValidation` to skip
 *   event-schema checks, `correlator` to override the framework or
 *   orchestrator-level correlator for this call only.
 * @returns The snapshot of the committed event
 *
 * @example
 * const snapshot = await action(Counter, "increment", { stream: "counter1", actor }, { by: 1 });
 */
export async function action<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TKey extends keyof TActions,
>(
  me: State<TState, TEvents, TActions>,
  action: TKey,
  target: Target,
  payload: Readonly<TActions[TKey]>,
  options?: DoOptions<TEvents>
): Promise<Snapshot<TState, TEvents>[]> {
  const { stream, expectedVersion, actor } = target;
  if (!stream) throw new Error("Missing target stream");
  const reactingTo = options?.reactingTo;
  const skipValidation = options?.skipValidation ?? false;
  const correlator = options?.correlator ?? default_correlator;

  // Action payloads are always validated — they come from external
  // callers (HTTP, RPC, queue consumers) and must be schema-checked at
  // the boundary. `skipValidation` only skips event-schema checks for
  // events the action itself synthesizes from already-trusted input.
  const validated = validate(action as string, payload, me.actions[action]);

  const opts = me.options?.[action];
  const max_retries = opts?.maxRetries ?? 0;

  for (let attempt = 0; ; attempt++) {
    try {
      const snapshot = await load(me, { stream, actor: target.actor });
      if (snapshot.event?.name === TOMBSTONE_EVENT)
        throw new StreamClosedError(stream);
      const expected = expectedVersion ?? snapshot.event?.version;

      if (me.given) {
        const invariants = me.given[action] || [];
        invariants.forEach(({ valid, description }) => {
          if (!valid(snapshot.state, actor))
            throw new InvariantError(
              action,
              validated,
              target,
              snapshot,
              description
            );
        });
      }

      const result = me.on[action](validated, snapshot, target);
      if (!result) return [snapshot];

      // An empty array means no events were emitted
      if (Array.isArray(result) && result.length === 0) {
        return [snapshot];
      }

      const tuples = Array.isArray(result[0])
        ? (result as Emitted<TEvents>[]) // array of tuples
        : ([result] as Emitted<TEvents>[]); // single tuple

      // ACT-403: warn once per process per event name when a dynamic
      // `.emit((a) => ["X", ...])` produces a deprecated event. Static
      // `.emit("X")` is already caught at build time by act-builder; this
      // is the runtime safety net for the dynamic form, which the static
      // checker can't inspect. The `_warned` set lives on the state so
      // multiple Act instances over the same merged state share idempotency.
      const deprecated = (me as { _deprecated?: Set<string> })._deprecated;
      if (deprecated && deprecated.size > 0) {
        const me_ = me as { _warned?: Set<string> };
        const warned = me_._warned ?? (me_._warned = new Set<string>());
        for (const [name] of tuples) {
          const evt = name as string;
          if (deprecated.has(evt) && !warned.has(evt)) {
            warned.add(evt);
            log().warn(
              `Action "${String(action)}" emitted deprecated event "${evt}". ` +
                `A newer version exists in the registry — update the action's ` +
                `.emit() to target the current version. (warned once per process)`
            );
          }
        }
      }

      const events = tuples.map(([name, data]) => ({
        name,
        data: skipValidation
          ? data
          : validate(name as string, data, me.events[name]),
      }));
      const emitted = events.map((v) => me.message(v));

      const meta: EventMeta = {
        correlation:
          reactingTo?.meta.correlation ||
          correlator({
            action: action as string,
            state: me.name,
            stream,
            actor: target.actor,
          }),
        causation: {
          action: {
            name: action as string,
            ...target,
            // payload intentionally omitted from causation metadata —
            // callers correlate via the correlation id when they need it.
          },
          event: reactingTo
            ? {
                id: reactingTo.id,
                name: reactingTo.name as string,
                stream: reactingTo.stream,
              }
            : undefined,
        },
      };

      let committed: Committed<TEvents, keyof TEvents>[];
      try {
        committed = await store().commit(
          stream,
          emitted,
          meta,
          // Reactions skip optimistic concurrency: they always append against the
          // current head. Stream leasing already serializes concurrent reactions,
          // and forcing version checks here would turn ordinary catch-up into
          // spurious retries.
          reactingTo ? undefined : expected
        );
      } catch (error) {
        // Invalidate cache on concurrency errors — cached state is stale
        if (error instanceof ConcurrencyError) {
          await cache().invalidate(stream);
        }
        throw error;
      }

      let { state, patches } = snapshot;
      const snapshots = committed.map((row, i) => {
        // Actions originate from the caller — they already hold the
        // plaintext payload they sent. No view/gate round-trip is
        // useful; the reducer and the returned snapshot see the
        // pre-split event directly. pii_split (in `me.message`) above
        // is the only PII operation on the action path.
        const event = { ...row, data: events[i].data };
        const p = me.patch[event.name](event, state);
        state = patch(state, p);
        patches++;
        return {
          event,
          state,
          version: event.version,
          patches,
          snaps: snapshot.snaps,
          patch: p,
          cache_hit: snapshot.cache_hit,
          replayed: snapshot.replayed,
        };
      });

      // fire and forget snaps
      const last = snapshots.at(-1)!;
      const snapped = me.snap?.(last);

      // #861: `has_open_pii` was set above during `emitted.map` — when
      // any commit carries open PII the derived state may hold plaintext
      // (reducers that copy sensitive fields into state against the soft
      // rule), so we refuse to populate the cache. Post-forget commits
      // never have pii; cache populates normally on the next access.
      // Update cache with post-commit state (reset patches if snapped).
      // Fire-and-forget — log but don't fail the action on cache write errors
      // (e.g., transient network failures in a custom Cache adapter).
      if (!me.pii_aware) {
        cache()
          .set<TState>(stream, {
            state: last.state,
            version: last.event.version,
            event_id: last.event.id,
            patches: snapped ? 0 : last.patches,
            snaps: snapped ? last.snaps + 1 : last.snaps,
          })
          .catch((err) => log().error(err));
      }

      // Persist snap to store for cold-start durability. Fire-and-forget:
      // snap() has its own try/catch that logs failures, so the rejection
      // can never escape — `void` is just to silence the floating-promise
      // lint (action() doesn't await store durability for the snapshot).
      if (snapped) void snap(last);

      return snapshots;
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
      if (attempt >= max_retries) throw error;
      if (opts?.backoff) {
        const delay_ms = compute_backoff_delay(attempt, opts.backoff);
        if (delay_ms > 0) await sleep(delay_ms);
      }
    }
  }
}
