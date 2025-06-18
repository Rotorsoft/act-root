import { z, ZodType } from "zod/v4";
import type { CommittedMeta, Schema, Schemas, State } from "./action";
import type { Reaction } from "./reaction";

export type EventRegister<E extends Schemas> = {
  [K in keyof E]: {
    schema: ZodType<E[K]>;
    reactions: Map<string, Reaction<E, K>>;
  };
};

export type SchemaRegister<A> = { [K in keyof A]: Schema };

export type Registry<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
> = {
  readonly actions: { [K in keyof A]: State<S[K], E, A> };
  readonly events: EventRegister<E>;
};

export type AsCommitted<R, K extends keyof R> = R[K] extends { schema: infer S }
  ? {
      readonly name: K;
      readonly data: z.infer<S>;
    } & CommittedMeta
  : never;
