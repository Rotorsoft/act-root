/**
 * @module event-sourcing
 * @category Event Sourcing
 *
 * Pure event-sourcing primitives: `snap` persists state checkpoints, `load`
 * reconstructs state by replaying events through reducers, and `action`
 * validates an action, runs invariants, emits events, and commits them
 * atomically.
 *
 * These are the bare implementations — observability is layered on top in
 * {@link "tracing"} and wired by the orchestrator at construction time.
 * No tracing imports here, no module-level mutable state.
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
  let state = cached?.state ?? (me.init ? me.init() : ({} as TState));
  let patches = cached?.patches ?? 0;
  let snaps = cached?.snaps ?? 0;
  let event: Committed<TEvents, string> | undefined;

  await store().query(
    (e) => {
      event = e as Committed<TEvents, string>;
      if (e.name === SNAP_EVENT) {
        state = e.data as TState;
        snaps++;
        patches = 0;
      } else if (me.patch[e.name]) {
        state = patch(state, me.patch[e.name](event, state));
        patches++;
      } else if (e.name !== TOMBSTONE_EVENT) {
        // Unknown event — not in this state's reducer map. Causes:
        // deleted/renamed event in a versioned schema, load() called with
        // the wrong state, or stream contamination. Skipping silently
        // would corrupt replay; warn so the operator can investigate.
        log().warn(
          `Skipping unknown event "${String(e.name)}" on stream "${stream}" (id=${e.id}) — no reducer in state "${me.name}"`
        );
      }
      callback && callback({ event, state, patches, snaps });
    },
    {
      stream,
      stream_exact: true,
      ...(cached ? { after: cached.event_id } : { with_snaps: true, ...asOf }),
    }
  );

  return { event, state, patches, snaps };
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
        // payload: TODO: flag to include action payload in metadata
        // not included by default to avoid large payloads
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
      // TODO: review reactions not enforcing expected version
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
    return { event, state, patches, snaps: snapshot.snaps, patch: p };
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

  // persist snap to store for cold start durability
  if (snapped) void snap(last);

  return snapshots;
}
