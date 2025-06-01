import { z, ZodType } from "zod/v4";
import {
  ActorSchema,
  CausationEventSchema,
  CommittedMetaSchema,
  EventMetaSchema,
  QuerySchema,
  TargetSchema,
} from "./schemas";

export type Actor = z.infer<typeof ActorSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type CausationEvent = z.infer<typeof CausationEventSchema>;
export type EventMeta = z.infer<typeof EventMetaSchema>;
export type CommittedMeta = z.infer<typeof CommittedMetaSchema>;
export type Query = z.infer<typeof QuerySchema>;

export type Schema = Record<string, any>;
export type Schemas = Record<string, Schema>;
export type EmptySchema = Record<string, never>;
export type Patch<T> = {
  [K in keyof T]?: T[K] extends Schema ? Patch<T[K]> : T[K];
};

export type Message<E extends Schemas, K extends keyof E> = {
  readonly name: K;
  readonly data: Readonly<E[K]>;
};

export type Committed<E extends Schemas, K extends keyof E> = Message<E, K> &
  CommittedMeta;

export type Snapshot<E extends Schemas, S extends Schema> = {
  readonly state: S;
  readonly event?: Committed<E, keyof E>; // undefined when initialized
  readonly patches: number;
  readonly snaps: number;
};

export type Invariant<S extends Schema> = {
  description: string;
  valid: (state: Readonly<S>, actor?: Actor) => boolean;
};

export type Emitted<E extends Schemas> = {
  [K in keyof E]: readonly [K, Readonly<E[K]>];
}[keyof E];

export type StateSchemas<
  E extends Schemas,
  A extends Schemas,
  S extends Schema,
> = {
  readonly events: { [K in keyof E]: ZodType<E[K]> };
  readonly actions: { [K in keyof A]: ZodType<A[K]> };
  readonly state: ZodType<S>;
};

export type ActionHandler<
  E extends Schemas,
  A extends Schemas,
  S extends Schema,
  K extends keyof A,
> = (
  action: Readonly<A[K]>,
  state: Readonly<S>,
  target: Target
) => Promise<Emitted<E> | Emitted<E>[] | undefined>;

export type State<
  E extends Schemas,
  A extends Schemas,
  S extends Schema,
> = StateSchemas<E, A, S> & {
  init: () => Readonly<S>;
  patch: {
    [K in keyof E]: (
      event: Committed<E, K>,
      state: Readonly<S>
    ) => Readonly<Patch<S>>;
  };
  on: { [K in keyof A]: ActionHandler<E, A, S, K> };
  given?: { [K in keyof A]?: Invariant<S>[] };
  snap?: (snapshot: Snapshot<E, S>) => boolean;
};

export type StateFactory<
  E extends Schemas = Schemas,
  A extends Schemas = Schemas,
  S extends Schema = Schema,
> = () => State<E, A, S>;

export type Infer<X> =
  X extends StateSchemas<infer E, infer A, infer S> ? State<E, A, S> : never;
