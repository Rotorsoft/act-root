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
export type ReactionsRegister<
  TEvents extends Schemas,
  TKey extends keyof TEvents,
> = {
  schema: ZodType<TEvents[TKey]>;
  reactions: Map<string, Reaction<TEvents, TKey>>;
};

/**
 * Maps event names to their schema and registered reactions.
 * @template TEvents - Event schemas.
 */
export type EventRegister<TEvents extends Schemas> = {
  [TKey in keyof TEvents]: ReactionsRegister<TEvents, TKey>;
};

/**
 * Maps action names to their schema definitions.
 * @template TSchemaReg - Schema register for actions.
 */
export type SchemaRegister<TSchemaReg> = {
  [TKey in keyof TSchemaReg]: Schema;
};

/**
 * Registry of all actions and events for a domain.
 * @template TSchemaReg - State schemas.
 * @template TEvents - Event schemas.
 * @template TActions - Action schemas.
 * @property actions - Map of action names to state definitions.
 * @property events - Map of event names to event registration info.
 */
export type Registry<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
> = {
  readonly actions: {
    [TKey in keyof TActions]: State<TSchemaReg[TKey], TEvents, TActions>;
  };
  readonly events: EventRegister<TEvents>;
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

/**
 * Utility type to map commited events from zod schema maps.
 * @template E - Event map.
 * @template K - Event name.
 */
export type CommittedOf<E, K extends keyof E> = E[K] extends z.ZodType
  ? {
      readonly name: K;
      readonly data: z.infer<E[K]>;
    } & CommittedMeta
  : never;
