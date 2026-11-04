/**
 * The `.emit` step, and what it checks on a handler's return value. TypeScript
 * doesn't check extra properties on a callback's return, so these do. Not
 * re-exported: the public surface is `.emit` itself.
 */
import type { ActionBuilder } from "./builders.js";
import type { Emitted, Schema, Schemas, Snapshot, Target } from "./index.js";

/** What a handler may return: one event, a list of them, or nothing. */
type EmitOut<TEvents extends Schemas> =
  | Emitted<TEvents>
  | readonly Emitted<TEvents>[]
  | undefined;

type NoOwnEvent = "an action must append an event to its own stream";

/**
 * Data with any field its schema doesn't declare typed `never`, at any depth.
 * A field the schema leaves open (`z.unknown()`, `z.any()`) takes anything.
 */
type Exact<TData, TSchema> = unknown extends TSchema
  ? TData
  : TSchema extends unknown
    ? TData extends readonly unknown[]
      ? TSchema extends readonly unknown[]
        ? {
            [I in keyof TData]: Exact<
              TData[I],
              I extends keyof TSchema ? TSchema[I] : TSchema[number]
            >;
          }
        : never
      : TData extends object
        ? TSchema extends object
          ? {
              [K in keyof TData]: K extends keyof TSchema
                ? Exact<TData[K], TSchema[K]>
                : never;
            }
          : never
        : TData
    : never;

type ExactEvent<TEvent, TAll> = TEvent extends readonly [
  infer TName extends keyof TAll,
  infer TData,
]
  ? readonly [TName, Exact<TData, TAll[TName]>]
  : TEvent;

/**
 * A handler's return, with extra fields and a missing own event made into
 * errors. Event names only known at runtime (`string`) can't be checked here.
 */
type CheckEmitted<TOut, TOwn, TAll> = string extends keyof TAll
  ? TOut
  : TOut extends readonly [PropertyKey, unknown]
    ? TOut[0] extends keyof TOwn
      ? ExactEvent<TOut, TAll>
      : NoOwnEvent
    : TOut extends readonly [unknown, ...unknown[]]
      ? [Extract<TOut[number], readonly [keyof TOwn, unknown]>] extends [never]
        ? NoOwnEvent
        : { [I in keyof TOut]: ExactEvent<TOut[I], TAll> }
      : TOut;

/** A handler whose returned events are checked. */
type EmitHandler<
  TState extends Schema,
  TEvents extends Schemas,
  TAction extends Schema,
  TLoaded extends Schemas,
  TRouted extends Schemas,
  TOut,
> = (
  action: Readonly<TAction>,
  snapshot: Readonly<Snapshot<TState, TEvents>>,
  target: Target,
  loaded: Readonly<TLoaded>
) => CheckEmitted<
  TOut,
  // A listed event goes to the loaded stream, even when this state declares it.
  Omit<TEvents, keyof TRouted>,
  TEvents & TRouted
>;

/**
 * `.emit`, finishing an action and returning `TDone`.
 *
 * The order of these four is load-bearing, so don't merge the duplicates. The
 * first handler gives a function with no parameters its types: TypeScript fixes
 * its return type on the first signature it meets. The name in between keeps
 * `.emit("Event")`. When more than three signatures fail, TypeScript reports
 * only the last one's error, at its exact place, so a mistake in a handler's
 * list is marked on the entry; `emit-types.spec.ts` guards that.
 */
type Emit<
  TState extends Schema,
  TEvents extends Schemas,
  TAction extends Schema,
  TLoaded extends Schemas,
  TRouted extends Schemas,
  TDone,
> = {
  /**
   * Finishes the action with a handler, which receives `(action, snapshot,
   * target, loaded)` and returns one or more `[EventName, data]` tuples (or
   * `undefined`): the state's own events, and the events listed on its loads.
   */
  <const TOut extends EmitOut<TEvents & TRouted>>(
    handler: EmitHandler<TState, TEvents, TAction, TLoaded, TRouted, TOut>
  ): TDone;
  /**
   * Finishes the action by passing the payload through as the data of an event
   * declared in `.emits()` that no load lists.
   */
  (event_name: Exclude<keyof TEvents & string, keyof TRouted>): TDone;
  (event_name: Exclude<keyof TEvents & string, keyof TRouted>): TDone;
  <const TOut extends EmitOut<TEvents & TRouted>>(
    handler: EmitHandler<TState, TEvents, TAction, TLoaded, TRouted, TOut>
  ): TDone;
};

/** The `.emit(...)` step that finishes an action declaration. */
export type ActionEmit<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string,
  TSnap extends boolean,
  TKey extends string,
  TNewActions extends Schema,
  TLoaded extends Schemas = {},
  TRouted extends Schemas = {},
> = Emit<
  TState,
  TEvents,
  TNewActions,
  TLoaded,
  TRouted,
  ActionBuilder<
    TState,
    TEvents,
    TActions & { [P in TKey]: TNewActions },
    TName,
    TSnap
  >
>;
