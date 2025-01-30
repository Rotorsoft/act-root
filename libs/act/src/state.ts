import { randomUUID } from "crypto";
import { ZodType } from "zod";
import { app, logger, store } from "./ports";
import { InvariantError, RegistrationError } from "./types/errors";
import type {
  Action,
  Actor,
  Event,
  EventMeta,
  Invariant,
  Msg,
  Patch,
  Query,
  Rec,
  RecRec,
  Snapshot
} from "./types/types";
import { patch, validate } from "./utils";

type Reducer<T extends Rec, E extends RecRec, K extends keyof E> = (
  state: Readonly<Patch<T>>,
  event: Event<Pick<E, K>, K>
) => Readonly<Patch<T>>;

type Handler<
  T extends Rec,
  A extends RecRec,
  E extends RecRec,
  K extends keyof A
> = (
  action: Readonly<A[K]>,
  state: Readonly<Patch<T>>,
  actor?: Actor
) => Promise<Msg<E, keyof E>[]>;

type SnapshotPredicate<T extends Rec, E extends RecRec> = (
  snapshot: Snapshot<T, E>
) => boolean;

type Schemas<T extends Rec, A extends RecRec, E extends RecRec> = {
  readonly __state: ZodType<T>;
  readonly __actions: { [K in keyof A]: ZodType<A[K]> };
  readonly __events: { [K in keyof E]: ZodType<E[K]> };
};

export type State<
  T extends Rec = Rec,
  A extends RecRec = RecRec,
  E extends RecRec = RecRec
> = Schemas<T, A, E> & {
  readonly description: string;
  init: () => Readonly<Patch<T>>;
  reduce: { [K in keyof E]: Reducer<T, E, K> };
  on: { [K in keyof A]: Handler<T, A, E, K> };
  given?: { [K in keyof A]?: Array<Invariant<T>> };
  snapshot?: SnapshotPredicate<T, E>;
};

export type Infer<S> =
  S extends Schemas<infer T, infer A, infer E> ? State<T, A, E> : never;

export const STATE_EVENT = "__state__";

async function commit_state<T extends Rec, A extends RecRec, E extends RecRec>(
  instance: State<T, A, E>,
  snapshot: Snapshot<T, E>
): Promise<void> {
  if (instance.snapshot && instance.snapshot(snapshot) && snapshot.event) {
    try {
      const { id, stream, name, meta: metadata, version } = snapshot.event;
      const event = await store().commit(
        stream,
        [{ name: STATE_EVENT, data: snapshot.state as any }],
        {
          correlation: metadata.correlation,
          causation: { event: { id, name: name as string, stream } }
        },
        version // IMPORTANT! - state events are committed right after the snapshot event
      );
      logger.trace({ event }, "<committed-state>");
    } catch (error) {
      logger.error(error);
    }
  }
}

async function commit<T extends Rec, A extends RecRec, E extends RecRec>(
  instance: State<T, A, E>,
  stream: string,
  events: Msg<E, keyof E>[],
  snapshot: Snapshot<T, E>,
  metadata: EventMeta
): Promise<Snapshot<T, E>[]> {
  let { state, applyCount } = snapshot;
  const msgs = events.map((e) => {
    if (e.name === STATE_EVENT) return e as Msg;
    const register = app().events.get(e.name as string);
    return { name: e.name, data: validate(e.data, register?.schema) } as Msg;
  });
  const committed = await store().commit(
    stream,
    msgs,
    metadata,
    metadata.causation.action?.expectedVersion || snapshot.event?.version
  );
  return committed.map((event) => {
    state = patch(
      state,
      instance.reduce[event.name](state, event as Event<Pick<E, string>>)
    );
    applyCount++;
    logger.trace({ event, state }, "<committed>");
    return {
      event,
      state,
      applyCount,
      stateCount: snapshot.stateCount
    } as Snapshot<T, E>;
  });
}

export async function load<T extends Rec, A extends RecRec, E extends RecRec>(
  instance: State<T, A, E>,
  id: { stream?: string; actor?: string },
  callback?: (snapshot: Snapshot<T, E>) => void
): Promise<Snapshot<T, E>> {
  let state = instance.init();
  let applyCount = 0;
  let stateCount = 0;
  let event: Event<E, keyof E> | undefined;

  await store().query(
    (e) => {
      event = e as Event<E>;
      if (e.name === STATE_EVENT) {
        state = e.data as Patch<T>;
        stateCount++;
        applyCount = 0;
      } else if (instance.reduce[e.name]) {
        state = patch(
          state,
          instance.reduce[e.name](state, e as Event<Pick<E, string>>)
        );
        applyCount++;
      }
      callback && callback({ event, state, applyCount, stateCount });
    },
    { ...id, loading: !!id.stream }
  );

  logger.trace({ id, applyCount, stateCount, state }, "<loaded>");

  return { event, state, applyCount, stateCount };
}

export async function act<T extends Rec, A extends RecRec, E extends RecRec>(
  action: Action<A, keyof A>,
  meta?: EventMeta,
  skipValidation = false
): Promise<Snapshot<T, E> | undefined> {
  const { action: name, stream, data, expectedVersion, actor } = action;
  if (!stream) throw new Error("Missing target stream");

  const register = app().actions.get(name as string);
  if (!register) throw new RegistrationError(name as string);
  const instance = register.factory() as unknown as State<T, A, E>;
  const validated = skipValidation ? data : validate(data, register.schema);

  logger.trace(
    { data: validated },
    `${name as string} on ${register.factory.name} ${stream}${expectedVersion ? `@${expectedVersion}` : ""}`
  );

  const snapshot = await load(instance, { stream });
  if (instance.given) {
    const invariants = instance.given[name] || [];
    invariants.forEach((invariant) => {
      if (!invariant.valid(snapshot.state, actor))
        throw new InvariantError<A>(
          name as string,
          action.data,
          { stream, expectedVersion, actor },
          invariant.description
        );
    });
  }
  const events = await instance.on[name](validated, snapshot.state, actor);

  if (events.length) {
    const snapshots = await commit(instance, stream, events, snapshot, {
      correlation: meta?.correlation || randomUUID(),
      causation: {
        ...meta?.causation,
        action: { name: name as string, stream, expectedVersion, actor }
        // TODO: flag to include command.data in metadata, not included by default to avoid duplicated payloads
      }
    });
    const last = snapshots.at(-1);
    app().emit("commit", { instance, snapshot: last });
    // fire and forget state events
    last && void commit_state(instance, last);
    return last;
  }
}

export async function query(
  query: Query,
  callback?: (event: Event) => void
): Promise<{ first?: Event; last?: Event; count: number }> {
  let first: Event | undefined = undefined,
    last: Event | undefined = undefined;
  const count = await store().query((e) => {
    !first && (first = e);
    last = e;
    callback && callback(e);
  }, query);
  return { first, last, count };
}

export const bind = <M extends RecRec, N extends keyof M>(
  name: N,
  data: Readonly<M[N]>
): Msg<M, N> => ({ name, data });

export const emit = <M extends RecRec, N extends keyof M>(
  name: N,
  data: Readonly<M[N]>
): Promise<Msg<M, N>[]> => Promise.resolve([bind(name, data)]);
