/**
 * What `.emit` checks on a handler's return value. TypeScript doesn't check
 * extra properties on a callback's return, so these do. Not part of the
 * public surface: `.emit` is.
 */
import type { Emitted, Schemas } from "./action.js";

/** What a handler may return: one event, a list of them, or nothing. */
export type EmitOut<TEvents extends Schemas> =
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
export type CheckEmitted<TOut, TOwn, TAll> = string extends keyof TAll
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
