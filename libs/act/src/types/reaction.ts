import { ZodType } from "zod";
import type { Committed, Schema, Schemas, Snapshot } from "./action";

export type ReactionHandler<E extends Schemas, K extends keyof E> = (
  event: Committed<E, K>,
  stream: string
) => Promise<Snapshot<E, Schema> | void>;

export type ReactionResolver<E extends Schemas, K extends keyof E> =
  | ((event: Committed<E, K>) => string | undefined)
  | string;

export type ReactionOptions = {
  readonly blockOnError: boolean;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
};

export type Reaction<E extends Schemas, K extends keyof E = keyof E> = {
  readonly handler: ReactionHandler<E, K>;
  readonly resolver: ReactionResolver<E, K>;
  readonly options: ReactionOptions;
};

export type ReactionPayload<E extends Schemas> = Reaction<E> & {
  readonly event: Committed<E, keyof E>;
};

export type EventRegister<E extends Schemas> = {
  [K in keyof E]: {
    schema: ZodType<E[K]>;
    reactions: Map<string, Reaction<E, K>>;
  };
};
