/**
 * Browser-safe deep merge utility — identical semantics to @rotorsoft/act's patch().
 * Inlined here so act-sse has zero Node dependencies.
 */

type Schema = Record<string, any>;
type Patch<T> = {
  [K in keyof T]?: T[K] extends Schema ? Patch<T[K]> : T[K];
};

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

/** Immutably deep-merge `patches` into `original`. */
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
