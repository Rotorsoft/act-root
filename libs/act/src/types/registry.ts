import { z, ZodType } from "zod";
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
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
> = {
  readonly actions: { [K in keyof A]: State<E, A, S[K]> };
  readonly events: EventRegister<E>;
};

export type AsCommitted<R extends EventRegister<any>, K extends keyof R> = {
  readonly name: K;
  readonly data: z.infer<R[K]["schema"]>;
} & CommittedMeta;
