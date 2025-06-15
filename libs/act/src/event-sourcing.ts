import { randomUUID } from "crypto";
import { logger, SNAP_EVENT, store } from "./ports";
import type {
  Committed,
  Emitted,
  EventMeta,
  Schema,
  Schemas,
  Snapshot,
  State,
  Target,
} from "./types";
import { InvariantError } from "./types/errors";
import { patch, validate } from "./utils";

export async function snap<E extends Schemas, S extends Schema>(
  snapshot: Snapshot<E, S>
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

export async function load<
  E extends Schemas,
  A extends Schemas,
  S extends Schema,
>(
  me: State<E, A, S>,
  stream: string,
  callback?: (snapshot: Snapshot<E, S>) => void
): Promise<Snapshot<E, S>> {
  let state = me.init();
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

export async function action<
  E extends Schemas,
  A extends Schemas,
  S extends Schema,
  K extends keyof A,
>(
  me: State<E, A, S>,
  action: K,
  target: Target,
  payload: Readonly<A[K]>,
  reactingTo?: Committed<Schemas, keyof Schemas>,
  skipValidation = false
): Promise<Snapshot<E, S>> {
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

  const tuples = Array.isArray(result[0])
    ? (result as Emitted<E>[]) // array of tuples
    : ([result] as Emitted<E>[]); // single tuple
  if (!tuples.length) return snapshot;

  const emitted = tuples.map(([name, data]) => ({
    name,
    data: validate(name as string, data, me.events[name]),
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
