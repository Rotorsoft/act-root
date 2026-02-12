import { z, ZodType } from "zod";
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
 * Represents an actor (user or system) performing an action.
 *
 * Actors provide audit trail and authorization context. Every action
 * must specify who is performing it for accountability and access control.
 *
 * @example User actor
 * ```typescript
 * const actor: Actor = {
 *   id: "user-123",
 *   name: "Alice Smith"
 * };
 * ```
 *
 * @example System actor
 * ```typescript
 * const systemActor: Actor = {
 *   id: "system",
 *   name: "Background Job"
 * };
 * ```
 */
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Target specification for action execution.
 *
 * Identifies which state instance (stream) should process the action
 * and who is performing it. The target combines the stream identifier
 * with actor context for complete audit trail.
 *
 * @example Basic target
 * ```typescript
 * const target: Target = {
 *   stream: "user-123",
 *   actor: { id: "admin", name: "Admin User" }
 * };
 *
 * await app.do("updateProfile", target, { email: "new@example.com" });
 * ```
 *
 * @example Dynamic stream ID
 * ```typescript
 * const userId = "user-" + Date.now();
 * await app.do("createUser", {
 *   stream: userId,
 *   actor: currentUser
 * }, userData);
 * ```
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
 *
 * @property `stream?` - Filter by stream name
 * @property `names?` - Filter by event names
 * @property `before?` - Filter events before this id
 * @property `after?` - Filter events after this id
 * @property `limit?` - Limit the number of events to return
 * @property `created_before?` - Filter events created before this date/time
 * @property `created_after?` - Filter events created after this date/time
 * @property `backward?` - Order descending when true
 * @property `correlation?` - Filter by correlation
 * @property `with_snaps?` - Include snapshots in the results, defaults to false
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
 *
 * Messages are the basic building blocks of the event log. Each message
 * has a name (event type) and data (event payload).
 *
 * @template E - Schemas map
 * @template K - Event/action name
 *
 * @example
 * ```typescript
 * const message: Message<{ Incremented: { amount: number } }, "Incremented"> = {
 *   name: "Incremented",
 *   data: { amount: 5 }
 * };
 * ```
 */
export type Message<E extends Schemas, K extends keyof E> = {
  /** The event or action name */
  readonly name: K;
  /** The event or action payload */
  readonly data: Readonly<E[K]>;
};

/**
 * A committed event with complete metadata.
 *
 * Committed events include the message data plus metadata about when and how
 * the event was created, including correlation and causation information for
 * tracing event-driven workflows.
 *
 * @template E - Schemas map
 * @template K - Event name
 *
 * @example
 * ```typescript
 * // Committed events include:
 * // - id: global sequence number
 * // - stream: which state instance
 * // - version: event number within stream
 * // - created: timestamp
 * // - meta: correlation and causation
 *
 * app.on("committed", (snapshots) => {
 *   snapshots.forEach(snap => {
 *     if (snap.event) {
 *       console.log(`Event ${snap.event.name} #${snap.event.id}`);
 *       console.log(`Stream: ${snap.event.stream} v${snap.event.version}`);
 *       console.log(`Data:`, snap.event.data);
 *     }
 *   });
 * });
 * ```
 *
 * @see {@link CommittedMeta} for metadata structure
 */
export type Committed<E extends Schemas, K extends keyof E> = Message<E, K> &
  CommittedMeta;

/**
 * Snapshot of state at a specific point in time.
 *
 * Snapshots represent the current state after applying events. They include
 * metadata about how many events have been applied (patches) and how many
 * snapshots have been taken for optimization.
 *
 * @template S - State schema
 * @template E - Event schemas
 *
 * @example
 * ```typescript
 * const snapshot = await app.load(Counter, "counter-1");
 *
 * console.log(snapshot.state);     // { count: 42 }
 * console.log(snapshot.patches);   // 8 (events since last snapshot)
 * console.log(snapshot.snaps);     // 1 (1 snapshot taken)
 * console.log(snapshot.event);     // Last event that created this snapshot
 * ```
 *
 * @example Using snapshot in action handler
 * ```typescript
 * .on("increment", z.object({ by: z.number() }))
 *   .emit((action, snapshot) => {
 *     console.log("Current count:", snapshot.state.count);
 *     console.log("Events applied:", snapshot.patches);
 *     return ["Incremented", { amount: action.by }];
 *   })
 * ```
 */
export type Snapshot<S extends Schema, E extends Schemas> = {
  /** Current state data */
  readonly state: S;
  /** Event that created this snapshot (undefined for initial state) */
  readonly event?: Committed<E, keyof E>;
  /** Number of patches applied since last snapshot */
  readonly patches: number;
  /** Number of snapshots taken for this stream */
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
  snapshot: Readonly<Snapshot<S, E>>,
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
  N extends string = string,
> = StateSchemas<S, E, A> & {
  name: N;
  init: () => Readonly<S>;
  patch: PatchHandlers<S, E>;
  on: ActionHandlers<S, E, A>;
  given?: GivenHandlers<S, A>;
  snap?: (snapshot: Snapshot<S, E>) => boolean;
};

/**
 * Extracts the raw action schemas from a State definition.
 *
 * Use this to recover the `A` type parameter from a built State object,
 * enabling construction of typed dispatchers without circular imports.
 *
 * @template T - A State object (or any object with `readonly actions: ZodTypes<A>`)
 *
 * @example
 * ```typescript
 * type Actions = InferActions<typeof Counter>;
 * // => { increment: { by: number } }
 * ```
 */
export type InferActions<
  T extends { readonly actions: Record<string, ZodType> },
> = {
  [K in keyof T["actions"]]: T["actions"][K] extends ZodType<infer V>
    ? V
    : never;
};

/**
 * Typed interface for the `app.do()` method, enabling reaction handlers
 * to dispatch actions with full autocomplete.
 *
 * Construct with {@link InferActions} to avoid circular imports between
 * slice files and the bootstrap module.
 *
 * @template A - Action schemas (maps action names to payload types)
 *
 * @example
 * ```typescript
 * import type { Dispatcher, InferActions } from "@rotorsoft/act";
 *
 * type App = Dispatcher<
 *   InferActions<typeof StateA> &
 *   InferActions<typeof StateB>
 * >;
 *
 * async function myReaction(event: ..., stream: string, app: App) {
 *   await app.do("someAction", target, payload, event);
 * }
 * ```
 */
export interface Dispatcher<A extends Schemas> {
  do<K extends keyof A & string>(
    action: K,
    target: Target,
    payload: Readonly<A[K]>,
    reactingTo?: Committed<Schemas, string>,
    skipValidation?: boolean
  ): Promise<any>;
}
