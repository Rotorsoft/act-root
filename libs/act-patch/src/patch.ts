import type { Patch, Schema } from "./types.js";

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
 * @param original - The original state object to patch (not mutated)
 * @param patches - The patches to apply (recursive partial of the state shape)
 * @returns A new state object with patches applied, sharing unpatched subtree references
 */
export const patch = <S extends Schema>(
  original: Readonly<S>,
  patches: Readonly<Patch<S>> | null | undefined
): Readonly<S> => {
  if (!patches) return original;

  const patch_keys = Object.keys(patches);
  if (patch_keys.length === 0) return original;

  // Spread is faster for small objects; two-pass avoids spread overhead on
  // large ones. Both branches must produce an ordinary-prototype object —
  // `Object.create(null)` here would return a prototype-less state (breaking
  // `instanceof`, `hasOwnProperty`, prototype-aware equality) for any state
  // with >16 top-level keys (#1318).
  const orig_keys = Object.keys(original);
  const copy: Record<string, any> =
    orig_keys.length <= 16 ? { ...original } : {};

  if (orig_keys.length > 16) {
    for (let i = 0; i < orig_keys.length; i++) {
      const key = orig_keys[i];
      if (key in patches) continue;
      copy[key] = original[key as keyof S];
    }
  }

  for (let i = 0; i < patch_keys.length; i++) {
    const key = patch_keys[i];
    const patched_value = patches[key as keyof typeof patches];
    if (patched_value === undefined || patched_value === null) {
      delete copy[key];
      continue;
    }
    if (typeof patched_value !== "object") {
      copy[key] = patched_value;
      continue;
    }
    const ctor = (patched_value as object).constructor;
    if (ctor === Object || ctor === undefined) {
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
