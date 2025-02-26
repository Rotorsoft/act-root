import type { Committed, EventMeta, Message, Query, Schemas } from "./action";
import type { Fetch, Lease } from "./reaction";

export type Disposer = () => Promise<void>;
export type Disposable = { dispose: Disposer };

export interface Store extends Disposable {
  seed: () => Promise<void>;
  drop: () => Promise<void>;

  // event store
  commit: <E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) => Promise<Committed<E, keyof E>[]>;
  query: <E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query,
    withSnaps?: boolean
  ) => Promise<number>;

  // stream watermarks
  fetch: <E extends Schemas>(limit: number) => Promise<Fetch<E>>;
  lease: (leases: Lease[]) => Promise<Lease[]>;
  ack: (leases: Lease[]) => Promise<void>;
}
