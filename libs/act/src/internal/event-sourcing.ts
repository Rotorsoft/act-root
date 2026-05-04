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
import { randomUUID } from "crypto";
import { cache, log, SNAP_EVENT, store, TOMBSTONE_EVENT } from "../ports.js";
import {
  ConcurrencyError,
  InvariantError,
  StreamClosedError,
} from "../types/errors.js";
import type {
  AsOf,
  Committed,
  Emitted,
  EventMeta,
  Schema,
  Schemas,
  Snapshot,
  State,
  Target,
} from "../types/index.js";
import { validate } from "../utils.js";

/** @internal */
export interface EsOps {
  snap: typeof snap;
  load: typeof load;
  action: typeof action;
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
 * Loads a snapshot of the state from the store by replaying events and applying patches.
 *
 * First checks the cache for a checkpoint, then queries the store for events
 * committed after the cached position. On cache miss, replays from the store
 * (using snapshots if available to avoid full replay).
 *
 * @template TState The type of state
 * @template TEvents The type of events
 * @template TActions The type of actions
 * @param me The state machine definition
 * @param stream The stream (instance) to load
 * @param callback (Optional) Callback to receive the loaded snapshot as it is built
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
  stream: string,
  callback?: (snapshot: Snapshot<TState, TEvents>) => void,
  asOf?: AsOf
): Promise<Snapshot<TState, TEvents>> {
  const timeTravel = !!asOf && Object.values(asOf).some((v) => v !== undefined);
  const cached = timeTravel ? undefined : await cache().get<TState>(stream);
  const cache_hit = !!cached;
  let state = cached?.state ?? (me.init ? me.init() : ({} as TState));
  let patches = cached?.patches ?? 0;
  let snaps = cached?.snaps ?? 0;
  // version always reflects stream head: starts from the cached version
  // (or -1 for a fresh stream / cache miss), advances per event seen.
  let version = cached?.version ?? -1;
  // replayed counts events processed by THIS load only (snap or patch);
  // distinct from `patches` (the snap-distance accumulator carried over
  // from the cache).
  let replayed = 0;
  let event: Committed<TEvents, string> | undefined;

  await store().query(
    (e) => {
      event = e as Committed<TEvents, string>;
      version = e.version;
      if (e.name === SNAP_EVENT) {
        state = e.data as TState;
        snaps++;
        patches = 0;
        replayed++;
      } else if (me.patch[e.name]) {
        state = patch(state, me.patch[e.name](event, state));
        patches++;
        replayed++;
      } else if (e.name !== TOMBSTONE_EVENT) {
        // Unknown event — not in this state's reducer map. Causes:
        // deleted/renamed event in a versioned schema, load() called with
        // the wrong state, or stream contamination. Skipping silently
        // would corrupt replay; warn so the operator can investigate.
        log().warn(
          `Skipping unknown event "${String(e.name)}" on stream "${stream}" (id=${e.id}) — no reducer in state "${me.name}"`
        );
      }
      callback &&
        callback({
          event,
          state,
          version,
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
  if (replayed > 0 && !timeTravel && event) {
    await cache().set(stream, {
      state,
      version,
      event_id: event.id,
      patches,
      snaps,
    });
  }

  return { event, state, version, patches, snaps, cache_hit, replayed };
}

/**
 * Executes an action and emits an event to be committed by the store.
 *
 * This function validates the action, applies business invariants, emits events, and commits them to the event store.
 *
 * @template TState The type of state
 * @template TEvents The type of events
 * @template TActions The type of actionSchemas
 * @template TKey The type of action to execute
 * @param me The state machine definition
 * @param action The action to execute
 * @param target The target (stream, actor, etc.)
 * @param payload The payload of the action
 * @param reactingTo (Optional) The event that the action is reacting to
 * @param skipValidation (Optional) Whether to skip validation (not recommended)
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
  reactingTo?: Committed<Schemas, keyof Schemas>,
  skipValidation = false
): Promise<Snapshot<TState, TEvents>[]> {
  const { stream, expectedVersion, actor } = target;
  if (!stream) throw new Error("Missing target stream");

  payload = skipValidation
    ? payload
    : validate(action as string, payload, me.actions[action]);

  const snapshot = await load(me, stream);
  if (snapshot.event?.name === TOMBSTONE_EVENT)
    throw new StreamClosedError(stream);
  const expected = expectedVersion ?? snapshot.event?.version;

  if (me.given) {
    const invariants = me.given[action] || [];
    invariants.forEach(({ valid, description }) => {
      if (!valid(snapshot.state, actor))
        throw new InvariantError(
          action,
          payload,
          target,
          snapshot,
          description
        );
    });
  }

  const result = me.on[action](payload, snapshot, target);
  if (!result) return [snapshot];

  // An empty array means no events were emitted
  if (Array.isArray(result) && result.length === 0) {
    return [snapshot];
  }

  const tuples = Array.isArray(result[0])
    ? (result as Emitted<TEvents>[]) // array of tuples
    : ([result] as Emitted<TEvents>[]); // single tuple

  const emitted = tuples.map(([name, data]) => ({
    name,
    data: skipValidation
      ? data
      : validate(name as string, data, me.events[name]),
  }));

  const meta: EventMeta = {
    correlation: reactingTo?.meta.correlation || randomUUID(),
    causation: {
      action: {
        name: action as string,
        ...target,
        // payload intentionally omitted: it can be large or contain PII,
        // and callers correlate via the correlation id when they need it.
      },
      event: reactingTo
        ? {
            id: reactingTo.id,
            name: reactingTo.name,
            stream: reactingTo.stream,
          }
        : undefined,
    },
  };

  let committed;
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
  const snapshots = committed.map((event) => {
    const p = me.patch[event.name](event, state);
    state = patch(state, p);
    patches++;
    // cache_hit / replayed propagate from the initial load — these
    // post-commit snapshots all derive from the same loaded state.
    // version advances per committed event (each is a new stream head).
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
  const snapped = me.snap && me.snap(last);

  // Update cache with post-commit state (reset patches if snapped).
  // Fire-and-forget — log but don't fail the action on cache write errors
  // (e.g., transient network failures in a custom Cache adapter).
  cache()
    .set<TState>(stream, {
      state: last.state,
      version: last.event.version,
      event_id: last.event.id,
      patches: snapped ? 0 : last.patches,
      snaps: snapped ? last.snaps + 1 : last.snaps,
    })
    .catch((err) => log().error(err));

  // Persist snap to store for cold-start durability. Fire-and-forget:
  // snap() has its own try/catch that logs failures, so the rejection
  // can never escape — `void` is just to silence the floating-promise
  // lint (action() doesn't await store durability for the snapshot).
  if (snapped) void snap(last);

  return snapshots;
}
