import EventEmitter from "events";
import { z } from "zod";
import * as es from "../event-sourcing";
import { store } from "../ports";
import type {
  Committed,
  CommittedMeta,
  EventRegister,
  Query,
  Schema,
  Schemas,
  Snapshot,
  State,
  StateFactory,
  Target,
} from "../types";

export type SchemaRegister<A> = { [K in keyof A]: Schema };

export type Registry<
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
> = {
  readonly actions: { [K in keyof A]: State<E, A, S[K]> };
  readonly events: EventRegister<E>;
};

export type AsCommitted<
  T extends Act<any, any, any>,
  K extends keyof T["events"],
> = {
  readonly name: K;
  readonly data: z.infer<T["events"][K]["schema"]>;
} & CommittedMeta;

type SnapshotArgs = Snapshot<Schemas, Schema>;

export class Act<
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
> {
  private _emitter = new EventEmitter();

  emit(event: "committed", args: SnapshotArgs) {
    return this._emitter.emit(event, args);
  }
  on(event: "committed", listener: (args: SnapshotArgs) => void): this {
    this._emitter.on(event, listener);
    return this;
  }

  constructor(public readonly registry: Registry<E, A, S>) {}

  get events() {
    return this.registry.events;
  }

  async do<K extends keyof A>(
    action: K,
    target: Target,
    payload: Readonly<A[K]>,
    reactingTo?: Committed<E, keyof E>,
    skipValidation = false
  ) {
    const snapshot = await es.action(
      this.registry.actions[action],
      action,
      target,
      payload,
      reactingTo as Committed<Schemas, keyof Schemas>,
      skipValidation
    );
    this.emit("committed", snapshot as SnapshotArgs);
    return snapshot;
  }

  async load<EX extends Schemas, AX extends Schemas, SX extends Schema>(
    factory: StateFactory<EX, AX, SX>,
    stream: string,
    callback?: (snapshot: Snapshot<EX, SX>) => void
  ): Promise<Snapshot<EX, SX>> {
    return await es.load(factory(), stream, callback);
  }

  async query(
    query: Query,
    callback?: (event: Committed<E, keyof E>) => void
  ): Promise<{
    first?: Committed<E, keyof E>;
    last?: Committed<E, keyof E>;
    count: number;
  }> {
    let first: Committed<E, keyof E> | undefined = undefined,
      last: Committed<E, keyof E> | undefined = undefined;
    const count = await store().query<E>((e) => {
      !first && (first = e);
      last = e;
      callback && callback(e);
    }, query);
    return { first, last, count };
  }
}
