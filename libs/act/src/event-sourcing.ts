/**
 * @module event-sourcing
 * @category Event Sourcing
 *
 * Utilities for event sourcing, snapshotting, and event store interaction.
 */

import { randomUUID } from "crypto";
import { logger, SNAP_EVENT, store } from "./ports.js";
import { InvariantError } from "./types/errors.js";
import type {
  Committed,
  Emitted,
  EventMeta,
  Schema,
  Schemas,
  Snapshot,
  State,
  Target,
} from "./types/index.js";
import { patch, validate } from "./utils.js";

/**
 * Event sourcing utilities for snapshotting, loading, and committing actions/events.
 * Used internally by Act and state machines.
 */

/**
 * Saves a snapshot of the state to the store.
 *
 * Snapshots are used to optimize state reconstruction for aggregates with long event streams.
 *
 * @template S The type of state
 * @template E The type of events
 * @param snapshot The snapshot to save
 * @returns Promise that resolves when the snapshot is saved
 *
 * @example
 * await snap(snapshot);
 */
export async function snap<S extends Schema, E extends Schemas>(
  snapshot: Snapshot<S, E>
): Promise<void> {
  try {
    const { id, stream, name, meta, version } = snapshot.event!;
    const snapped = await store().commit(
      stream,
      [{ name: SNAP_EVENT, data: snapshot.state }],
      {
        correlation: meta.correlation,
        causation: { event: { id, name: name as string, stream } },
      },
      version // IMPORTANT! - state events are committed right after the snapshot event
    );
    logger.trace(snapped, "🟠 snap");
  } catch (error) {
    logger.error(error);
  }
}

/**
 * Loads a snapshot of the state from the store by replaying events and applying patches.
 *
 * @template S The type of state
 * @template E The type of events
 * @template A The type of actions
 * @param me The state machine definition
 * @param stream The stream (instance) to load
 * @param callback (Optional) Callback to receive the loaded snapshot as it is built
 * @returns The snapshot of the loaded state
 *
 * @example
 * const snapshot = await load(Counter, "counter1");
 */
export async function load<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
>(
  me: State<S, E, A>,
  stream: string,
  callback?: (snapshot: Snapshot<S, E>) => void
): Promise<Snapshot<S, E>> {
  let state = me.init ? me.init() : ({} as S);
  let patches = 0;
  let snaps = 0;
  let event: Committed<E, string> | undefined;
  await store().query(
    (e) => {
      event = e as Committed<E, string>;
      if (e.name === SNAP_EVENT) {
        state = e.data as S;
        snaps++;
        patches = 0;
      } else if (me.patch[e.name]) {
        state = patch(state, me.patch[e.name](event, state));
        patches++;
      }
      callback && callback({ event, state, patches, snaps });
    },
    { stream, with_snaps: true }
  );
  logger.trace({ stream, patches, snaps, state }, "🟢 load");
  return { event, state, patches, snaps };
}

/**
 * Executes an action and emits an event to be committed by the store.
 *
 * This function validates the action, applies business invariants, emits events, and commits them to the event store.
 *
 * @template S The type of state
 * @template E The type of events
 * @template A The type of actionSchemas
 * @template K The type of action to execute
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
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
  K extends keyof A,
>(
  me: State<S, E, A>,
  action: K,
  target: Target,
  payload: Readonly<A[K]>,
  reactingTo?: Committed<Schemas, keyof Schemas>,
  skipValidation = false
): Promise<Snapshot<S, E>[]> {
  const { stream, expectedVersion, actor } = target;
  if (!stream) throw new Error("Missing target stream");

  payload = skipValidation
    ? payload
    : validate(action as string, payload, me.actions[action]);
  logger.trace(
    payload,
    `🔵 ${action as string} "${stream}${expectedVersion ? `@${expectedVersion}` : ""}"`
  );

  const snapshot = await load(me, stream);
  if (me.given) {
    const invariants = me.given[action] || [];
    invariants.forEach(({ valid, description }) => {
      if (!valid(snapshot.state, actor))
        throw new InvariantError(
          action as string,
          payload,
          target,
          description
        );
    });
  }

  let { state, patches } = snapshot;
  const result = me.on[action](payload, state, target);
  if (!result) return [snapshot];

  // An empty array means no events were emitted
  if (Array.isArray(result) && result.length === 0) {
    return [snapshot];
  }

  const tuples = Array.isArray(result[0])
    ? (result as Emitted<E>[]) // array of tuples
    : ([result] as Emitted<E>[]); // single tuple

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

  const committed = await store().commit(
    stream,
    emitted,
    meta,
    // TODO: review reactions not enforcing expected version
    reactingTo ? undefined : expectedVersion || snapshot.event?.version
  );

  const snapshots = committed.map((event) => {
    state = patch(state, me.patch[event.name](event, state));
    patches++;
    return { event, state, patches, snaps: snapshot.snaps };
  });
  logger.trace(snapshots, "🔴 commit");

  // fire and forget snaps
  const last = snapshots.at(-1)!;
  me.snap && me.snap(last) && void snap(last);

  return snapshots;
}
