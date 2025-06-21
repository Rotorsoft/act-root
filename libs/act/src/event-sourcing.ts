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
 * @template S The type of state
 * @template E The type of events
 * @param snapshot The snapshot to save
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
 * Loads a snapshot of the state from the store.
 *
 * @template S The type of state
 * @template E The type of events
 * @param me The state machine
 * @param stream The stream to load
 * @param callback The callback to call with the snapshot
 * @returns The snapshot of the loaded state
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
    { stream },
    true
  );
  logger.trace({ stream, patches, snaps, state }, "🟢 load");
  return { event, state, patches, snaps };
}

/**
 * Executes an action and emits an event to be committed by the store.
 *
 * @template S The type of state
 * @template E The type of events
 * @template A The type of actionSchemas
 * @template K The type of action to execute
 * @param me The state machine
 * @param action The action to execute
 * @param target The target of the action
 * @param payload The payload of the action
 * @param reactingTo The event that the action is reacting to
 * @param skipValidation Whether to skip validation
 * @returns The snapshot of the committed Event
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
): Promise<Snapshot<S, E>> {
  const { stream, expectedVersion, actor } = target;
  if (!stream) throw new Error("Missing target stream");

  payload = skipValidation
    ? payload
    : validate(action as string, payload, me.actions[action]);
  logger.trace(
    payload,
    `🔵 ${action as string} "${stream}${expectedVersion ? `@${expectedVersion}` : ""}"`
  );

  let snapshot = await load(me, stream);
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
  if (!result) return snapshot;

  // An empty array means no events were emitted
  if (Array.isArray(result) && result.length === 0) {
    return snapshot;
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

  snapshot = committed
    .map((event) => {
      state = patch(state, me.patch[event.name](event, state));
      patches++;
      logger.trace({ event, state }, "🔴 commit");
      return { event, state, patches, snaps: snapshot.snaps };
    })
    .at(-1)!;

  me.snap && me.snap(snapshot) && void snap(snapshot); // fire and forget snaps
  return snapshot;
}
