import type { Event, EventMeta, Msg, Query } from "./types";

export type Disposer = () => Promise<void>;
export type Seeder = () => Promise<void>;
export interface Disposable {
  readonly name: string;
  dispose: Disposer;
}

/** Stores events in streams */
export interface Store extends Disposable {
  /**
   * Commits events by stream
   * @param stream stream name
   * @param events array of events
   * @param meta metadata
   * @param expectedVersion optional expected version to provide optimistic concurrency
   * @returns array of committed events
   */
  commit: (
    stream: string,
    events: Msg[],
    meta: EventMeta,
    expectedVersion?: number
  ) => Promise<Event[]>;

  /**
   * Queries the event store
   * @param callback callback predicate
   * @param query optional query values
   * @returns number of records
   */
  query: (callback: (event: Event) => void, query?: Query) => Promise<number>;

  seed: () => Promise<void>;
  drop: () => Promise<void>;
}
