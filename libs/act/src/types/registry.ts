import { z, ZodType } from "zod";
import type { CommittedMeta, Schema, Schemas, State } from "./action.js";
import type { Reaction } from "./reaction.js";

/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types for event and action registries in the Act Framework.
 */

/**
 * Reactions register
 */
export type ReactionsRegister<E extends Schemas, K extends keyof E> = {
  schema: ZodType<E[K]>;
  reactions: Map<string, Reaction<E, K>>;
};

/**
 * Maps event names to their schema and registered reactions.
 * @template E - Event schemas.
 */
export type EventRegister<E extends Schemas> = {
  [K in keyof E]: ReactionsRegister<E, K>;
};

/**
 * Maps action names to their schema definitions.
 * @template A - Action schemas.
 */
export type SchemaRegister<A> = { [K in keyof A]: Schema };

/**
 * Registry of all actions and events for a domain.
 * @template S - State schemas.
 * @template E - Event schemas.
 * @template A - Action schemas.
 * @property actions - Map of action names to state definitions.
 * @property events - Map of event names to event registration info.
 */
export type Registry<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
> = {
  readonly actions: { [K in keyof A]: State<S[K], E, A> };
  readonly events: EventRegister<E>;
};

/**
 * Utility type to convert a registry entry to a committed event type.
 * @template R - Registry map.
 * @template K - Event name.
 */
export type AsCommitted<R, K extends keyof R> = R[K] extends { schema: infer S }
  ? {
      readonly name: K;
      readonly data: z.infer<S>;
    } & CommittedMeta
  : never;
