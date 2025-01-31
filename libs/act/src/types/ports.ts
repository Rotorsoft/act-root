import type { Committed, EventMeta, Message, Query, Schemas } from "./action";

export type Disposer = () => Promise<void>;
export type Disposable = { dispose: Disposer };

export interface Store extends Disposable {
  commit: <E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) => Promise<Committed<E, keyof E>[]>;
  query: <E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) => Promise<number>;
  seed: () => Promise<void>;
  drop: () => Promise<void>;
}
