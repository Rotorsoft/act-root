export type Rec = Record<string, any>;
export type RecRec = Record<string, Rec>;
export type Empty = Record<string, never>;

export type DeepPartial<T> =
  T extends Array<infer I>
    ? Array<DeepPartial<I>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;
export type Patch<T extends Rec> = DeepPartial<T>;

export type Actor = {
  readonly id: string;
  readonly name: string;
};

export type Invariant<T extends Rec> = {
  description: string;
  valid: (state: Readonly<Patch<T>>, actor?: Actor) => boolean;
};

/**
 * Options to query the all stream
 * - `stream?` filter by stream
 * - `names?` filter by event names
 * - `before?` filter events before this id
 * - `after?` filter events after this id
 * - `limit?` limit the number of events to return
 * - `created_before?` filter events created before this date/time
 * - `created_after?` filter events created after this date/time
 * - `backward?` order descending when true
 * - `correlation?` filter by correlation
 * - `actor?` filter by actor id (mainly used to reduce process managers)
 * - `loading?` flag when loading to optimize queries
 */
export type Query = {
  readonly stream?: string;
  readonly names?: string[];
  readonly before?: number;
  readonly after?: number;
  readonly limit?: number;
  readonly created_before?: Date;
  readonly created_after?: Date;
  readonly backward?: boolean;
  readonly correlation?: string;
  readonly actor?: string;
  readonly loading?: boolean;
};

/**
 * Schemas, actions, messages, events, etc
 */

export type Msg<M extends RecRec = RecRec, N extends keyof M = keyof M> = {
  readonly name: N;
  readonly data: Readonly<M[N]>;
};

export type Target = {
  readonly stream: string;
  readonly expectedVersion?: number;
  readonly actor?: Actor;
};

export type Action<M extends RecRec, N extends keyof M> = Target & {
  readonly action: N;
  readonly data: Readonly<M[N]>;
};

export type EventMeta = {
  readonly correlation: string;
  readonly causation: {
    readonly action?: Target & {
      readonly name: string;
    };
    readonly event?: {
      readonly name: string;
      readonly stream: string;
      readonly id: number;
    };
  };
};

export type Event<M extends RecRec = RecRec, N extends keyof M = keyof M> = Msg<
  M,
  N
> & {
  readonly name: N;
  readonly data: Readonly<M[N]>;
  readonly id: number;
  readonly stream: string;
  readonly version: number;
  readonly created: Date;
  readonly meta: EventMeta;
};

export type Snapshot<T extends Rec, E extends RecRec> = {
  readonly state: Readonly<Patch<T>>;
  readonly event?: Event<E, keyof E>; // undefined when initialized
  readonly applyCount: number;
  readonly stateCount: number;
};
