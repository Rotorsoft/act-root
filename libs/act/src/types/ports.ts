import type { Committed, EventMeta, Message, Query, Schemas } from "./action";
import { EventRegister, Reaction, ReactionPayload } from "./reaction";

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

export interface Queue<E extends Schemas> {
  readonly stream: string;
  readonly position: number;
  readonly blocked: boolean;
  get next(): ReactionPayload<E> | undefined;
  enqueue(event: Committed<E, keyof E>, reaction: Reaction<E>): void;
  ack(position: number, dequeue?: boolean): Promise<boolean>;
  block(): Promise<boolean>;
}

export interface QueueStore extends Disposable {
  fetch: <E extends Schemas>(
    register: EventRegister<E>,
    limit: number
  ) => Promise<{ events: Committed<E, keyof E>[]; queues: Queue<E>[] }>;
}
