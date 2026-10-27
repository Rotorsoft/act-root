/**
 * Event-sourcing primitives: `snap`, `load`, `action`, `tombstone`, `scan`.
 * Bare implementations; tracing wraps them in `tracing.ts`.
 */

import { patch } from "@rotorsoft/act-patch";
import { cache, log, store } from "../ports.js";
import {
  ConcurrencyError,
  InvariantError,
  StreamClosedError,
} from "../types/errors.js";
import type {
  CacheEntry,
  Committed,
  DoOptions,
  Emitted,
  EventMeta,
  EventSource,
  LoadTarget,
  PatchFn,
  ScanOptions,
  ScanResult,
  Schema,
  Schemas,
  Snapshot,
  State,
  Target,
} from "../types/index.js";
import { SNAP_EVENT, TOMBSTONE_EVENT } from "../types/index.js";
import { sleep, validate } from "../utils.js";
import { compute_backoff_delay } from "./backoff.js";
import { default_correlator } from "./correlation-id.js";

/** The default patch step: a bare merge, so the hot path pays nothing. */
export const bare_patch: PatchFn = (_me, state, partial) =>
  patch(state, partial) as typeof state;

/**
 * `validateFoldedState`: merge, then parse against the state schema, so a
 * bad reducer fails at its own event. A debugging aid, not a production guard.
 */
export const validating_patch: PatchFn = (me, state, partial, event) => {
  const next = patch(state, partial) as typeof state;
  return validate(
    `${me.name}.${String(event.name)}#${event.id}`,
    next,
    me.state
  );
};

const DEFAULT_BATCH = 500;

/** `action` with the correlator and patch step bound by `build_es`. */
type BoundAction = <
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

export interface EsOps {
  snap: typeof snap;
  load: typeof load;
  action: BoundAction;
  tombstone: typeof tombstone;
}

/** Writes a cache checkpoint. A failure only costs the next load a re-fold. */
const cache_put = <TState extends Schema>(
  stream: string,
  entry: CacheEntry<TState>
): Promise<void> =>
  cache()
    .set(stream, entry)
    .catch((err) =>
      log().warn(
        err,
        "cache set skipped; the next load re-folds from the store"
      )
    );

/** Drops a cache checkpoint. A failure leaves a stale one, which re-folds. */
const cache_drop = (stream: string): Promise<void> =>
  cache()
    .invalidate(stream)
    .catch((err) =>
      log().warn(
        err,
        "cache invalidate skipped; a stale checkpoint re-folds from its event_id"
      )
    );

/** Commits a snapshot event. Never throws: a failed snapshot must not fail the action. */
export async function snap<TState extends Schema, TEvents extends Schemas>(
  snapshot: Snapshot<TState, TEvents>
): Promise<Committed<TEvents, keyof TEvents> | undefined> {
  const { id, stream, name, meta, version } = snapshot.event!;
  try {
    const [committed] = await store().commit(
      stream,
      [{ name: SNAP_EVENT, data: snapshot.state }],
      {
        correlation: meta.correlation,
        causation: { event: { id, name: name as string, stream } },
      },
      version // IMPORTANT! - state events are committed right after the snapshot event
    );
    return committed as Committed<TEvents, keyof TEvents>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log().warn(
      `Snapshot write failed on stream "${stream}": ${reason} — cold starts will replay full history until snapshots succeed.`
    );
  }
}

/**
 * Commits the close guard at `expectedVersion`; `undefined` when the stream
 * moved. Actions then see the tombstone at head and throw {@link StreamClosedError}.
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
 * Rejects a negative version or an invalid `created` Date. Duplicate ids and
 * version gaps are left to the sink (partial backups have gaps).
 */
function is_valid(event: Committed<Schemas, keyof Schemas>): boolean {
  if (event.version < 0) return false;
  if (!(event.created instanceof Date) || Number.isNaN(event.created.getTime()))
    return false;
  return true;
}

/**
 * Pages a restore source: validation, drop filters, migrations, progress and
 * causation remap. Adapters supply only the per-event insert `callback`
 * (see {@link Store.restore}). A source that ignores `limit` (`CsvFile`)
 * returns everything in one page.
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

  // `drop_closed_streams`: one extra walk to collect tombstoned streams.
  const closed_streams = new Set<string>();
  if (drop_closed_streams) {
    await source.query<Schemas>(
      (e) => {
        if (e.name === TOMBSTONE_EVENT) closed_streams.add(e.stream);
      },
      { names: [TOMBSTONE_EVENT] }
    );
  }

  // Probe the highest id (an index seek on SQL stores). A source that
  // ignores the filter returns more than one row; leave max_id unknown.
  let max_id: number | undefined;
  const probed = await source.query<Schemas>(
    (e) => {
      max_id = e.id;
    },
    { backward: true, limit: 1, with_snaps: true }
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
          // Keep the tombstone: it is what keeps the stream closed.
          dropped_closed++;
          return;
        }
        // Before the causation remap, so `id_map` stays keyed by source id.
        let migrated: typeof event = event;
        const migration = event_migrations?.[event.name as string];
        if (migration) {
          const old_data = migration.from_schema.parse(event.data);
          const new_data = migration.migrate(old_data);
          migration.to_schema.parse(new_data);
          migrated = {
            ...event,
            name: migration.to as typeof event.name,
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
        let remapped = migrated;
        const caused_by = migrated.meta.causation.event?.id;
        if (caused_by !== undefined) {
          const new_caused_by = id_map.get(caused_by);
          if (new_caused_by !== undefined && new_caused_by !== caused_by) {
            // Spread `migrated`, not `event`, or the migration is undone.
            remapped = {
              ...migrated,
              meta: {
                ...migrated.meta,
                causation: {
                  ...migrated.meta.causation,
                  event: {
                    ...migrated.meta.causation.event!,
                    id: new_caused_by,
                  },
                },
              },
            };
          }
        }
        const new_id = await callback(remapped);
        id_map.set(event.id, new_id);
        kept++;
      },
      { after: at, limit, with_snaps: true }
    );

    // Stop on a short page, or on an oversized one (the source ignored the
    // limit and already returned everything).
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
 * Folds a stream into state, from the cached checkpoint or the latest
 * snapshot. `asOf` time-travels and bypasses the cache.
 */
export async function load<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
>(
  me: State<TState, TEvents, TActions>,
  target: LoadTarget,
  callback?: (snapshot: Snapshot<TState, TEvents>) => void,
  patch_fn: PatchFn = bare_patch
): Promise<Snapshot<TState, TEvents>> {
  const { stream, actor, asOf } = target;
  const time_travel =
    !!asOf && Object.values(asOf).some((v) => v !== undefined);
  const cached = time_travel ? undefined : await cache().get<TState>(stream);
  const cache_hit = !!cached;
  let state = cached?.state ?? (me.init ? me.init() : ({} as TState));
  let patches = cached?.patches ?? 0;
  let snaps = cached?.snaps ?? 0;
  // Events this load processed; `patches` is the snap distance from the cache.
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
        state = patch_fn(me, state, me.patch[event.name](event, state), event);
        patches++;
        replayed++;
      } else if (event.name !== TOMBSTONE_EVENT) {
        // A renamed event, the wrong state, or a contaminated stream.
        log().warn(
          `Skipping unknown event "${String(event.name)}" on stream "${stream}" (id=${event.id}) — no reducer in state "${me.name}"`
        );
      }
      callback?.({
        event,
        state,
        version: event.version,
        id: event.id,
        patches,
        snaps,
        cache_hit,
        replayed,
      });
    },
    {
      stream,
      stream_exact: true,
      // `with_snaps` on every non-time-travel load: cold, it resumes from the
      // latest snapshot; warm, it keeps a snapshot above a stale checkpoint,
      // so a windowed close's prune can't fold the tail onto stale state.
      ...(cached
        ? { after: cached.event_id, with_snaps: true }
        : { ...(time_travel ? {} : { with_snaps: true }), ...asOf }),
    }
  );

  // A stale write self-corrects: the next load replays past its `event_id`.
  // Not at a tombstone head, or `action()`'s closed check would pass vacuously.
  const head_is_tombstone = event?.name === TOMBSTONE_EVENT;
  if (
    replayed > 0 &&
    !time_travel &&
    event &&
    !me.pii_aware &&
    !head_is_tombstone
  ) {
    await cache_put(stream, {
      stream,
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
    // Captured with `state`, so consumers never race a separate cache lookup.
    id: event?.id ?? cached?.event_id ?? -1,
    patches,
    snaps,
    cache_hit,
    replayed,
  };
}

/**
 * Validates, checks invariants and preconditions, emits and commits. On {@link ConcurrencyError}
 * it re-runs from `load` within the action's `maxRetries`; any other error
 * rethrows. Reactions commit without the inferred version guard.
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
  options?: DoOptions<TEvents>,
  patch_fn: PatchFn = bare_patch
): Promise<Snapshot<TState, TEvents>[]> {
  const { stream, expectedVersion, actor } = target;
  if (!stream) throw new Error("Missing target stream");
  // `Act.do` already filled in the ambient reaction context.
  const reactingTo = options?.reactingTo;
  const correlator = options?.correlator ?? default_correlator;

  const validated = validate(action as string, payload, me.actions[action]);

  const opts = me.options?.[action];
  const max_retries = opts?.maxRetries ?? 0;

  for (let attempt = 0; ; attempt++) {
    try {
      const snapshot = await load(
        me,
        { stream, actor: target.actor },
        undefined,
        patch_fn
      );
      if (snapshot.event?.name === TOMBSTONE_EVENT)
        throw new StreamClosedError(stream);
      // `version`, not `event`: on a warm hit `event` is undefined. A new
      // stream (-1) stays unguarded.
      const expected =
        expectedVersion ??
        (snapshot.version >= 0 ? snapshot.version : undefined);

      // Invariants, then preconditions, each in declaration order: the
      // first rule that fails refuses the action.
      for (const { valid, description } of me.given?.[action] ?? [])
        if (!valid(snapshot.state, actor))
          throw new InvariantError(
            action,
            validated,
            target,
            snapshot,
            description
          );
      for (const { holds, description } of me.requires?.[action] ?? [])
        if (!holds(validated, snapshot.state, actor))
          throw new InvariantError(
            action,
            validated,
            target,
            snapshot,
            description,
            "precondition"
          );

      const result = me.on[action](validated, snapshot, target);
      if (!result || (Array.isArray(result) && !result.length))
        return [snapshot];

      const tuples = Array.isArray(result[0])
        ? (result as Emitted<TEvents>[]) // array of tuples
        : ([result] as Emitted<TEvents>[]); // single tuple

      const events = tuples.map(([name, data]) => ({
        name,
        data: validate(name as string, data, me.events[name]),
      }));
      const emitted = events.map((e) => me.message(e));

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
            // payload intentionally omitted
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
          // Reactions skip the inferred version guard (leases already
          // serialize them); an explicit expectedVersion is still honored.
          reactingTo ? expectedVersion : expected
        );
      } catch (error) {
        // Fire-and-forget, so a cache failure can't replace the ConcurrencyError.
        if (error instanceof ConcurrencyError) void cache_drop(stream);
        throw error;
      }

      let { state, patches } = snapshot;
      const snapshots = committed.map((row, i) => {
        // The caller sent the plaintext, so no view/gate round-trip.
        const event = { ...row, data: events[i].data };
        const p = me.patch[event.name](event, state);
        state = patch_fn(me, state, p, event);
        patches++;
        return {
          event,
          state,
          version: event.version,
          id: event.id,
          patches,
          snaps: snapshot.snaps,
          patch: p,
          cache_hit: snapshot.cache_hit,
          replayed: snapshot.replayed,
        };
      });

      const last = snapshots.at(-1)!;
      // A guardless (reaction) commit can land past events this fold never
      // saw; a gapped fold must not become a snapshot or a cache entry.
      const contiguous = committed[0].version === snapshot.version + 1;
      const snapped = contiguous && me.snap?.(last);

      // Awaited, so the cache holds the post-snap checkpoint for the next caller.
      const snap_event = snapped ? await snap(last) : undefined;

      // Sensitive states depend on the actor, so they aren't cached.
      if (!me.pii_aware) {
        if (contiguous)
          void cache_put<TState>(stream, {
            stream,
            state: last.state,
            version: snap_event?.version ?? last.event.version,
            event_id: snap_event?.id ?? last.event.id,
            patches: snap_event ? 0 : last.patches,
            snaps: snap_event ? last.snaps + 1 : last.snaps,
          });
        else void cache_drop(stream);
      }

      return snapshots;
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
      // A caller-pinned version would conflict again on every retry.
      if (expectedVersion !== undefined) throw error;
      if (attempt >= max_retries) throw error;
      if (opts?.backoff) {
        const delay_ms = compute_backoff_delay(attempt, opts.backoff);
        if (delay_ms > 0) await sleep(delay_ms);
      }
    }
  }
}
