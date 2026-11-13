/**
 * Event-sourcing primitives: `snap`, `load`, `action`, `tombstone`, `scan`.
 * Bare implementations; tracing wraps them in `tracing.ts`.
 */

import { patch } from "@rotorsoft/act-patch";
import { prettifyError, ZodError, type ZodType } from "zod";
import { cache, log, store } from "../ports.js";
import {
  ConcurrencyError,
  PreconditionError,
  StreamClosedError,
  ValidationError,
} from "../types/errors.js";
import type {
  CacheEntry,
  Committed,
  DoOptions,
  Emitted,
  EventMeta,
  EventSource,
  Load,
  LoadTarget,
  Message,
  PatchFn,
  ScanOptions,
  ScanResult,
  Schema,
  Schemas,
  Snapshot,
  State,
  Target,
} from "../types/index.js";
import {
  REDACTED,
  SHREDDED,
  SNAP_EVENT,
  TOMBSTONE_EVENT,
} from "../types/index.js";
import { sleep, validate } from "../utils.js";
import { compute_backoff_delay } from "./backoff.js";
import { default_correlator } from "./correlation-id.js";

/** The default patch step: a bare merge, so the hot path pays nothing. */
export const bare_patch: PatchFn = (_me, state, partial) =>
  patch(state, partial) as typeof state;

const value_at = (value: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (at, key) => (at as Record<PropertyKey, unknown> | undefined)?.[key],
    value
  );

/**
 * Checks the state an action leaves against the state's schema (its
 * invariants), without replacing it: a schema with defaults or transforms
 * never rewrites a valid state. A throwing refinement refuses like a failed
 * one, as `validate` does for payloads.
 *
 * A sensitive state is folded through the committing actor's view, so a
 * value it can't read arrives as `[REDACTED]` or `[SHREDDED]`. Those come
 * only from stored history, which passed this check with the real value,
 * so their issues are dropped.
 */
const check_invariants = <TState extends Schema>(
  target: string,
  state: TState,
  schema: ZodType<TState>,
  pii_aware: boolean
): void => {
  let result: ReturnType<typeof schema.safeParse>;
  try {
    result = schema.safeParse(state);
  } catch (error) {
    throw new ValidationError(target, state, error);
  }
  if (result.success) return;
  const issues = pii_aware
    ? result.error.issues.filter((issue) => {
        const value = value_at(state, issue.path);
        return value !== REDACTED && value !== SHREDDED;
      })
    : result.error.issues;
  if (issues.length)
    throw new ValidationError(
      target,
      state,
      prettifyError(new ZodError(issues))
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
      [
        {
          stream,
          msgs: [{ name: SNAP_EVENT, data: snapshot.state }],
          // IMPORTANT! - state events are committed right after the snapshot event
          expectedVersion: version,
        },
      ],
      {
        correlation: meta.correlation,
        causation: { event: { id, name: name as string, stream } },
      }
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
      [
        {
          stream,
          msgs: [{ name: TOMBSTONE_EVENT, data: {} }],
          expectedVersion,
        },
      ],
      { correlation, causation: {} }
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
        // A source that ignores `after` (a CSV file) hands back events this
        // scan already read; skip them, or a full page repeats forever.
        if (at !== undefined && event.id <= at) return;
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
        // Spread `migrated`, not `event`, or the migration is undone.
        let remapped = migrated;
        const { action, event: cause } = migrated.meta.causation;
        if (cause || (stream_rename && action)) {
          remapped = {
            ...migrated,
            meta: {
              ...migrated.meta,
              causation: {
                ...migrated.meta.causation,
                ...(action &&
                  stream_rename && {
                    action: { ...action, stream: stream_rename(action.stream) },
                  }),
                ...(cause && {
                  event: {
                    ...cause,
                    // A cause missing from the source has no id in the new
                    // log; its old id would name another event there.
                    id: id_map.get(cause.id) ?? -1,
                    stream: stream_rename
                      ? stream_rename(cause.stream)
                      : cause.stream,
                  },
                }),
              },
            },
          };
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
  // `limit` and `created_after` read a slice of the real events, without a seed.
  const seeded =
    time_travel && asOf!.limit === undefined && !asOf!.created_after;
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
      // Time travel folds the real events. A snapshot only seeds it, holding what
      // a prune or a restart took, so it counts only as the first row.
      if (seeded && raw.name === SNAP_EVENT && replayed > 0) return;
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
        : seeded
          ? // From the start, past the resume floor, which could jump over the
            // time bound. The snapshots are for the seed.
            { with_snaps: true, after: -1, ...asOf }
          : time_travel
            ? asOf
            : { with_snaps: true }),
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

/** A stream an action may append to (its own, or one of its loads'), with the events it emits there. */
type Pending = {
  readonly state: State<any, any, any>;
  readonly stream: string;
  readonly snapshot: Snapshot<any, any>;
  readonly expected: number;
  readonly events: { name: string; data: Schema }[];
};

/**
 * Loads the other streams an action's decision needs, all at once. A target
 * returning `undefined` skips its load. A target can name a stream from the
 * caller's input, so an empty name, the action's own stream or another load's
 * refuses the action, as a rule would. A load of a closed stream throws.
 */
async function load_others(
  loads: readonly Load[],
  payload: Schema,
  own: { stream: string; state: Schema },
  actor: Target["actor"],
  patch_fn: PatchFn,
  refuse: (description: string) => Error
): Promise<(Pending | undefined)[]> {
  const streams = loads.map((l) => l.target(payload, own.state));
  streams.forEach((stream, i) => {
    if (stream === undefined) return;
    if (typeof stream !== "string" || !stream)
      throw refuse(`loads "${loads[i].name}" from an empty stream name`);
    if (stream === own.stream) throw refuse(`loads its own stream "${stream}"`);
    if (streams.indexOf(stream) !== i)
      throw refuse(`loads stream "${stream}" twice`);
  });
  return Promise.all(
    loads.map(async (l, i) => {
      const stream = streams[i];
      if (stream === undefined) return undefined;
      const snapshot = await load(
        l.state,
        { stream, actor },
        undefined,
        patch_fn
      );
      if (snapshot.event?.name === TOMBSTONE_EVENT)
        throw new StreamClosedError(stream);
      return {
        state: l.state,
        stream,
        snapshot,
        expected: snapshot.version,
        events: [],
      };
    })
  );
}

/**
 * Validates, checks preconditions, folds, checks the invariants and commits.
 * An action with loads appends to every stream it emits to in one commit,
 * each guarded by its version at load. On {@link ConcurrencyError} it
 * re-runs from `load` within the action's `maxRetries`; any other error
 * rethrows.
 *
 * Returns the snapshots of every stream appended to, the action's own first.
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
  const loads = me.loads?.[action] ?? [];

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
      // stream expects -1, so two callers creating it can't both commit.
      const own: Pending = {
        state: me,
        stream,
        snapshot,
        expected: expectedVersion ?? snapshot.version,
        events: [],
      };
      const others = loads.length
        ? await load_others(
            loads,
            validated,
            { stream, state: snapshot.state },
            target.actor,
            patch_fn,
            (description) =>
              new PreconditionError(
                action,
                validated,
                target,
                snapshot,
                description
              )
          )
        : [];
      const loaded = Object.fromEntries(
        others.map((p, i) => [loads[i].name, p?.snapshot.state])
      );

      // Preconditions in declaration order: the first that fails refuses
      // the action.
      for (const { holds, description } of me.requires?.[action] ?? [])
        if (!holds(validated, snapshot.state, actor, loaded))
          throw new PreconditionError(
            action,
            validated,
            target,
            snapshot,
            description
          );

      const result = me.on[action](validated, snapshot, target, loaded);
      if (!result || (Array.isArray(result) && !result.length))
        return [snapshot];

      const tuples = Array.isArray(result[0])
        ? (result as Emitted<TEvents>[]) // array of tuples
        : ([result] as Emitted<TEvents>[]); // single tuple

      // An event listed on a load goes to that load's stream, and is dropped
      // when the load was skipped; the state's own events go to its own stream.
      for (const [name, data] of tuples) {
        const event = name as string;
        const i = loads.findIndex((l) => l.events.includes(event));
        if (i >= 0 && !others[i]) continue;
        const to = i >= 0 ? others[i] : name in me.events ? own : undefined;
        if (!to)
          throw new Error(
            `Action "${action as string}" emitted "${event}", which isn't an event of "${me.name}" and isn't listed on any of its loads`
          );
        to.events.push({
          name: event,
          data: validate(event, data, to.state.events[event]),
        });
      }
      // The action's own stream records the decision, so an action that
      // appends to other streams appends to its own too.
      if (!own.events.length)
        throw new Error(
          `Action "${action as string}" appends only to the streams it loads; it must append an event to its own stream too`
        );
      const appends = [own, ...others].filter(
        (p): p is Pending => !!p?.events.length
      );

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

      // Fold before the commit (the decider rule), so a state that breaks
      // its schema (the invariants) is refused before anything is stored.
      // Each event folds onto its own stream's state. Reducers see the event
      // data and the next version; the store assigns `id` and `created`, so
      // they get placeholders here (`-1`, the commit time).
      const created = new Date();
      const folds = appends.map((p) => {
        let { state, patches } = p.snapshot;
        const folded = p.events.map((e, i) => {
          const event = {
            ...e,
            id: -1,
            stream: p.stream,
            version: p.snapshot.version + i + 1,
            created,
            meta,
          };
          const patch = p.state.patch[event.name](event, state);
          state = patch_fn(p.state, state, patch, event);
          patches++;
          return { state, patch, patches };
        });
        // Once per stream, on the state the action leaves: invariants hold
        // between actions, not between one action's events.
        check_invariants(
          `${p.state.name}.${action as string}`,
          state,
          p.state.state,
          p.state.pii_aware
        );
        return folded;
      });

      let committed: Committed<Schemas, keyof Schemas>[];
      try {
        committed = await store().commit<Schemas>(
          appends.map((p) => ({
            stream: p.stream,
            msgs: p.events.map((e) => p.state.message(e)) as Message<
              Schemas,
              string
            >[],
            expectedVersion: p.expected,
          })),
          meta
        );
      } catch (error) {
        // Fire-and-forget, so a cache failure can't replace the ConcurrencyError.
        if (error instanceof ConcurrencyError) void cache_drop(error.stream);
        throw error;
      }

      // The stored rows come back in append order, then event order, with
      // the real `id` and `created`; the states are already folded. The
      // caller sent the plaintext, so no view/gate round-trip.
      let row = 0;
      const snapshots: Snapshot<any, any>[] = [];
      for (const [a, append] of appends.entries()) {
        const { snapshot: base, state: owner } = append;
        const appended = append.events.map((e, i) => {
          const stored = committed[row++];
          const fold = folds[a][i];
          return {
            event: { ...stored, data: e.data },
            state: fold.state,
            version: stored.version,
            id: stored.id,
            patches: fold.patches,
            snaps: base.snaps,
            patch: fold.patch,
            cache_hit: base.cache_hit,
            replayed: base.replayed,
          };
        });
        const last = appended.at(-1)!;

        // Awaited, so the cache holds the post-snap checkpoint for the next caller.
        const snap_event = owner.snap?.(last) ? await snap(last) : undefined;

        // Sensitive states depend on the actor, so they aren't cached.
        if (!owner.pii_aware)
          void cache_put(append.stream, {
            stream: append.stream,
            state: last.state,
            version: snap_event?.version ?? last.event.version,
            event_id: snap_event?.id ?? last.event.id,
            patches: snap_event ? 0 : last.patches,
            snaps: snap_event ? last.snaps + 1 : last.snaps,
          });
        // The snapshot is the stream's head now, so a version pinned from this
        // result doesn't refuse the caller's own next action.
        if (snap_event)
          appended[appended.length - 1] = {
            ...last,
            version: snap_event.version,
          };
        snapshots.push(...appended);
      }

      return snapshots;
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
      // A caller-pinned version would conflict again on every retry.
      if (expectedVersion !== undefined && error.stream === stream) throw error;
      if (attempt >= max_retries) throw error;
      if (opts?.backoff) {
        const delay_ms = compute_backoff_delay(attempt, opts.backoff);
        if (delay_ms > 0) await sleep(delay_ms);
      }
    }
  }
}
