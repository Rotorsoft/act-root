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
export type ZodTypes<T extends Schemas> = {
  [K in keyof T]: ZodType<T[K]>;
};

export type Message<E extends Schemas, K extends keyof E> = {
  readonly name: K;
  readonly data: Readonly<E[K]>;
};

export type Committed<E extends Schemas, K extends keyof E> = Message<E, K> &
  CommittedMeta;

export type Snapshot<S extends Schema, E extends Schemas> = {
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
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = {
  readonly events: ZodTypes<E>;
  readonly actions: ZodTypes<A>;
  readonly state: ZodType<S>;
};

export type PatchHandler<
  S extends Schema,
  E extends Schemas,
  K extends keyof E,
> = (event: Committed<E, K>, state: Readonly<S>) => Readonly<Patch<S>>;

export type PatchHandlers<S extends Schema, E extends Schemas> = {
  [K in keyof E]: PatchHandler<S, E, K>;
};

export type ActionHandler<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
  K extends keyof A,
> = (
  action: Readonly<A[K]>,
  state: Readonly<S>,
  target: Target
) => Emitted<E> | Emitted<E>[] | undefined;

export type ActionHandlers<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = {
  [K in keyof A]: ActionHandler<S, E, A, K>;
};

export type GivenHandlers<S extends Schema, A extends Schemas> = {
  [K in keyof A]?: Invariant<S>[];
};

export type State<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = StateSchemas<S, E, A> & {
  name: string;
  init: () => Readonly<S>;
  patch: PatchHandlers<S, E>;
  on: ActionHandlers<S, E, A>;
  given?: GivenHandlers<S, A>;
  snap?: (snapshot: Snapshot<S, E>) => boolean;
};
