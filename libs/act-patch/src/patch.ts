import type { Patch, Schema } from "./types.js";

/** These objects are replaced instead of deep merged */
const UNMERGEABLES = [
  RegExp,
  Date,
  Array,
  Map,
  Set,
  WeakMap,
  WeakSet,
  ArrayBuffer,
  /* v8 ignore next */
  ...(typeof SharedArrayBuffer !== "undefined" ? [SharedArrayBuffer] : []),
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

/** Returns true if the value is a plain object eligible for deep merging. */
export const is_mergeable = (value: unknown): boolean =>
  !!value &&
  typeof value === "object" &&
  !UNMERGEABLES.some((t) => value instanceof t);

/**
 * Immutably deep-merges `patches` into `original`.
 *
 * This is a **pure function** — it never mutates its arguments and always
 * returns a deterministic result for the same inputs.
 *
 * **Merging rules:**
 * - Plain objects: Deep merge recursively
 * - Arrays, Dates, RegExp, Maps, Sets, TypedArrays: Replace entirely
 * - `undefined` or `null` values: Delete the property
 * - Primitives: Replace with patch value
 *
 * **Structural sharing:**
 * Unpatched subtrees are reused by reference, not deep-copied. This is safe
 * because Act state is always `Readonly<S>` and events are immutable — state
 * is only ever updated through new patches. This is the same approach used by
 * Immer, Redux Toolkit, and other immutable state libraries.
 *
 * **Optimizations:**
 * 1. Short-circuits on empty patch — returns original by reference (zero allocation)
 * 2. Fast-path for primitives — skips is_mergeable when typeof !== "object"
 * 3. Structural sharing — unpatched subtrees reuse the original reference
 * 4. Two-pass key enumeration — avoids temporary { ...original, ...patches } spread
 * 5. Prototype-free result — Object.create(null) avoids prototype-chain lookups
 *
 * @param original - The original state object to patch (not mutated)
 * @param patches - The patches to apply (recursive partial of the state shape)
 * @returns A new state object with patches applied, sharing unpatched subtree references
 */
export const patch = <S extends Schema>(
  original: Readonly<S>,
  patches: Readonly<Patch<S>> | null | undefined
): Readonly<S> => {
  // Guard: null/undefined patches — return original by reference
  if (!patches) return original;

  const patchKeys = Object.keys(patches);

  // Short-circuit: no patches — return original by reference (zero allocation)
  if (patchKeys.length === 0) return original;

  const copy = Object.create(null) as Record<string, any>;
  const origKeys = Object.keys(original);

  // Copy original keys not present in patches (structural sharing)
  for (let i = 0; i < origKeys.length; i++) {
    const key = origKeys[i];
    if (key in patches) continue;
    // Reuse reference — no deep copy of unpatched subtrees
    copy[key] = original[key as keyof S];
  }

  // Apply patch keys
  for (let i = 0; i < patchKeys.length; i++) {
    const key = patchKeys[i];
    const patched_value = patches[key as keyof typeof patches];
    // Fast delete check
    if (patched_value === undefined || patched_value === null) continue;
    // Fast-path: primitive values skip is_mergeable entirely
    if (typeof patched_value !== "object") {
      copy[key] = patched_value;
      continue;
    }
    // Object value — check if it should be deep merged or replaced
    if (is_mergeable(patched_value)) {
      const original_value = original[key as keyof S];
      copy[key] = patch(
        (original_value || {}) as Schema,
        patched_value as Patch<Schema>
      );
    } else {
      copy[key] = patched_value;
    }
  }

  return copy as S;
};
