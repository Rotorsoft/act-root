import { z, ZodType } from "zod/v4";
import {
  ActorSchema,
  CausationEventSchema,
  CommittedMetaSchema,
  EventMetaSchema,
  QuerySchema,
  TargetSchema,
} from "./schemas.js";

/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types for actions, events, schemas, and state in the Act Framework.
 */

/**
 * Represents an actor (user, system, etc.) that initiates actions or events.
 */
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Represents the target of an action or event, including stream and actor info.
 */
export type Target = z.infer<typeof TargetSchema>;

/**
 * Metadata describing the causation of an event.
 */
export type CausationEvent = z.infer<typeof CausationEventSchema>;

/**
 * Metadata attached to an event, including correlation and causation.
 */
export type EventMeta = z.infer<typeof EventMetaSchema>;

/**
 * Metadata attached to a committed event, including id, stream, version, and creation time.
 */
export type CommittedMeta = z.infer<typeof CommittedMetaSchema>;

/**
 * Query options for event store queries.
 */
export type Query = z.infer<typeof QuerySchema>;

/**
 * A generic schema definition (plain object shape).
 */
export type Schema = Record<string, any>;

/**
 * A map of named schemas.
 */
export type Schemas = Record<string, Schema>;

/**
 * An empty schema (no properties).
 */
export type EmptySchema = Record<string, never>;

/**
 * A recursive partial type for patching state objects.
 * @template T - The base type to patch.
 */
export type Patch<T> = {
  [K in keyof T]?: T[K] extends Schema ? Patch<T[K]> : T[K];
};

/**
 * Maps schema names to their Zod type representations.
 * @template T - The schemas map.
 */
export type ZodTypes<T extends Schemas> = {
  [K in keyof T]: ZodType<T[K]>;
};

/**
 * Represents a message (event or action) with a name and data payload.
 * @template E - Schemas map.
 * @template K - Event/action name.
 */
export type Message<E extends Schemas, K extends keyof E> = {
  readonly name: K;
  readonly data: Readonly<E[K]>;
};

/**
 * A committed event, including metadata.
 * @template E - Schemas map.
 * @template K - Event name.
 */
export type Committed<E extends Schemas, K extends keyof E> = Message<E, K> &
  CommittedMeta;

/**
 * Represents a snapshot of state at a point in the event stream.
 * @template S - State schema.
 * @template E - Event schemas.
 */
export type Snapshot<S extends Schema, E extends Schemas> = {
  readonly state: S;
  readonly event?: Committed<E, keyof E>; // undefined when initialized
  readonly patches: number;
  readonly snaps: number;
};

/**
 * An invariant is a condition that must always hold true for a state.
 * @template S - State schema.
 */
export type Invariant<S extends Schema> = {
  description: string;
  valid: (state: Readonly<S>, actor?: Actor) => boolean;
};

/**
 * Represents an emitted event tuple from an action handler.
 * @template E - Event schemas.
 */
export type Emitted<E extends Schemas> = {
  [K in keyof E]: readonly [K, Readonly<E[K]>];
}[keyof E];

/**
 * Bundles the Zod types for state, events, and actions.
 * @template S - State schema.
 * @template E - Event schemas.
 * @template A - Action schemas.
 */
export type StateSchemas<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = {
  readonly events: ZodTypes<E>;
  readonly actions: ZodTypes<A>;
  readonly state: ZodType<S>;
};

/**
 * Handles patching state in response to a committed event.
 * @template S - State schema.
 * @template E - Event schemas.
 * @template K - Event name.
 */
export type PatchHandler<
  S extends Schema,
  E extends Schemas,
  K extends keyof E,
> = (event: Committed<E, K>, state: Readonly<S>) => Readonly<Patch<S>>;

/**
 * Maps event names to their patch handlers.
 * @template S - State schema.
 * @template E - Event schemas.
 */
export type PatchHandlers<S extends Schema, E extends Schemas> = {
  [K in keyof E]: PatchHandler<S, E, K>;
};

/**
 * Handles an action, producing one or more emitted events.
 * @template S - State schema.
 * @template E - Event schemas.
 * @template A - Action schemas.
 * @template K - Action name.
 */
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

/**
 * Maps action names to their handlers.
 * @template S - State schema.
 * @template E - Event schemas.
 * @template A - Action schemas.
 */
export type ActionHandlers<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = {
  [K in keyof A]: ActionHandler<S, E, A, K>;
};

/**
 * Maps action names to invariants that must hold after the action.
 * @template S - State schema.
 * @template A - Action schemas.
 */
export type GivenHandlers<S extends Schema, A extends Schemas> = {
  [K in keyof A]?: Invariant<S>[];
};

/**
 * The full state definition, including schemas, handlers, and optional invariants and snapshot logic.
 * @template S - State schema.
 * @template E - Event schemas.
 * @template A - Action schemas.
 */
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
