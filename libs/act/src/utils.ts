import { ZodError, type ZodType, prettifyError } from "zod/v4";
import { config } from "./config.js";
import type { Patch, Schema } from "./types/index.js";
import { ValidationError } from "./types/index.js";

/** These objects are copied instead of deep merged */
const UNMERGEABLES = [
  RegExp,
  Date,
  Array,
  Map,
  Set,
  WeakMap,
  WeakSet,
  ArrayBuffer,
  SharedArrayBuffer,
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
];

const is_mergeable = (value: any): boolean =>
  !!value &&
  typeof value === "object" &&
  !UNMERGEABLES.some((t) => value instanceof t);

/**
 * Utility functions for patching state, validation, extending objects, and async helpers.
 *
 * - Use `patch()` to immutably update state with patches.
 * - Use `validate()` to validate payloads against Zod schemas.
 * - Use `extend()` to merge and validate configuration objects.
 * - Use `sleep()` for async delays.
 *
 * @module utils
 */

/**
 * Immutably copies state with patches recursively.
 *
 * Keys with `undefined` or `null` values in patch are deleted.
 *
 * @param original The original state object
 * @param patches The patches to merge
 * @returns A new patched state
 *
 * @example
 * const newState = patch(oldState, { count: 5 });
 */
export const patch = <S extends Schema>(
  original: Readonly<S>,
  patches: Readonly<Patch<S>>
): Readonly<S> => {
  const copy = {} as Record<string, any>;
  Object.keys({ ...original, ...patches }).forEach((key) => {
    const patched_value = patches[key as keyof typeof patches];
    const original_value = original[key as keyof typeof original];
    const patched = patches && key in patches;
    const deleted =
      patched &&
      (typeof patched_value === "undefined" || patched_value === null);
    const value = patched && !deleted ? patched_value : original_value;
    !deleted &&
      (copy[key] = is_mergeable(value)
        ? patch(original_value || {}, patched_value || {})
        : value);
  });
  return copy as S;
};

/**
 * Validates a payload against a Zod schema, throwing a ValidationError on failure.
 *
 * @param target The name of the target (for error reporting)
 * @param payload The payload to validate
 * @param schema (Optional) The Zod schema to validate against
 * @returns The validated payload
 * @throws ValidationError if validation fails
 *
 * @example
 * const valid = validate("User", userPayload, userSchema);
 */
export const validate = <S>(
  target: string,
  payload: Readonly<S>,
  schema?: ZodType<S>
): Readonly<S> => {
  try {
    return schema ? schema.parse(payload) : payload;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      throw new ValidationError(
        target,
        payload,
        prettifyError(error as ZodError)
      );
    }
    throw new ValidationError(target, payload, error);
  }
};

/**
 * Extends the target payload with the source payload after validating the source.
 *
 * @param source The source object to validate and merge
 * @param schema The Zod schema for the source
 * @param target (Optional) The target object to extend
 * @returns The merged and validated object
 *
 * @example
 * const config = extend(envConfig, configSchema, defaultConfig);
 */
export const extend = <
  S extends Record<string, unknown>,
  T extends Record<string, unknown>,
>(
  source: Readonly<S>,
  schema: ZodType<S>,
  target?: Readonly<T>
): Readonly<S & T> => {
  const value = validate("config", source, schema);
  return Object.assign(target || {}, value) as Readonly<S & T>;
};

/**
 * Async helper to pause execution for a given number of milliseconds.
 *
 * @param ms (Optional) Milliseconds to sleep (defaults to config().sleepMs)
 * @returns Promise that resolves after the delay
 *
 * @example
 * await sleep(1000); // sleep for 1 second
 */
export async function sleep(ms?: number) {
  return new Promise((resolve) => setTimeout(resolve, ms ?? config().sleepMs));
}
