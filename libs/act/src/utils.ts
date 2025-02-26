import { ZodError, type ZodType } from "zod";
import { config } from "./config";
import type { Patch, Schema } from "./types";
import { ValidationError } from "./types";

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
 * Copies state with patches recursively.
 * Keys with `undefined` or `null` values in patch are deleted.
 * @param original original state
 * @param patches patches to merge
 * @returns a new patched state
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

export const validate = <S>(
  target: string,
  payload: Readonly<S>,
  schema?: ZodType<S>
): Readonly<S> => {
  try {
    return schema ? schema.parse(payload) : payload;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const { _errors, ...details } = (error as ZodError).format();
      throw new ValidationError(target, payload, details);
    }
    throw new ValidationError(target, payload, error);
  }
};

/**
 * Extends target payload with source payload after validating source
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

export async function sleep(ms?: number) {
  return new Promise((resolve) => setTimeout(resolve, ms ?? config().sleepMs));
}
