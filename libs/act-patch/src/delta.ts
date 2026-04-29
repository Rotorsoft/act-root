import type { Patch, Schema } from "./types.js";

/**
 * Deep semantic equality matching the types `patch` documents:
 *
 * - Plain objects: recurse field-wise
 * - Arrays / TypedArrays: length + element-wise equal
 * - `Date`: `getTime()` equal
 * - `RegExp`: `source` + `flags` equal
 * - `Map`: size + entries equal (iteration order ignored)
 * - `Set`: size + every member equal (iteration order ignored)
 * - Primitives: `Object.is` (handles `NaN`, `±0` correctly)
 *
 * Anything outside this list (e.g. `WeakMap`, `ArrayBuffer`) falls through
 * to `false` — `delta` will emit a replacement, matching `patch`'s
 * "replace everything that isn't a plain object" rule.
 */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;

  const aCtor = a.constructor;
  const bCtor = b.constructor;
  const aPlain = aCtor === Object || aCtor === undefined;
  const bPlain = bCtor === Object || bCtor === undefined;
  if (aPlain !== bPlain) return false;
  if (!aPlain && aCtor !== bCtor) return false;

  if (aPlain) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      const k = aKeys[i];
      if (!(k in b)) return false;
      if (!deepEqual((a as any)[k], (b as any)[k])) return false;
    }
    return true;
  }

  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!deepEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }

  if (a instanceof Date) return a.getTime() === (b as Date).getTime();

  if (a instanceof RegExp) {
    const rB = b as RegExp;
    return a.source === rB.source && a.flags === rB.flags;
  }

  if (a instanceof Map) {
    const mB = b as Map<unknown, unknown>;
    if (a.size !== mB.size) return false;
    for (const [k, v] of a as Map<unknown, unknown>) {
      if (!mB.has(k)) return false;
      if (!deepEqual(v, mB.get(k))) return false;
    }
    return true;
  }

  if (a instanceof Set) {
    const sB = b as Set<unknown>;
    if (a.size !== sB.size) return false;
    for (const v of a as Set<unknown>) if (!sB.has(v)) return false;
    return true;
  }

  // TypedArrays (Uint8Array, Float64Array, BigInt64Array, etc.)
  if (ArrayBuffer.isView(a)) {
    const tA = a as unknown as {
      length: number;
      [i: number]: number | bigint;
    };
    const tB = b as unknown as {
      length: number;
      [i: number]: number | bigint;
    };
    if (tA.length !== tB.length) return false;
    for (let i = 0; i < tA.length; i++) if (tA[i] !== tB[i]) return false;
    return true;
  }

  return false;
};

/**
 * Compute the smallest `Patch<S>` that, when applied to `before`, yields
 * an object semantically equal to `after`. The semantic inverse of `patch()`.
 *
 * **Round-trip guarantee:**
 *   `patch(before, delta(before, after))` deeply equals `after`.
 *
 * **Rules** (mirror `patch`'s merging rules):
 * - Key in `before` AND `after`, semantically equal       → omitted
 * - Key in `before` AND `after`, NOT semantically equal   → set to `after[K]` (recurse for plain objects)
 * - Key in `after` only                                   → set to `after[K]`
 * - Key in `before` only                                  → set to `null` (delete)
 *
 * @param before - The original state object
 * @param after - The desired state object
 * @returns The smallest patch that transforms `before` into `after`
 */
export const delta = <S extends Schema>(
  before: Readonly<S>,
  after: Readonly<S>
): Readonly<Patch<S>> => {
  if (Object.is(before, after)) return {} as Patch<S>;

  const out: Record<string, any> = {};
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);

  for (let i = 0; i < beforeKeys.length; i++) {
    const k = beforeKeys[i];
    if (!(k in after)) out[k] = null;
  }

  for (let i = 0; i < afterKeys.length; i++) {
    const k = afterKeys[i];
    const a = (after as any)[k];
    const b = (before as any)[k];
    if (!(k in before)) {
      out[k] = a;
      continue;
    }
    if (Object.is(a, b)) continue;

    const aIsPlain =
      typeof a === "object" &&
      a !== null &&
      (a.constructor === Object || a.constructor === undefined);
    const bIsPlain =
      typeof b === "object" &&
      b !== null &&
      (b.constructor === Object || b.constructor === undefined);
    if (aIsPlain && bIsPlain) {
      const sub = delta(b as Schema, a as Schema);
      if (Object.keys(sub).length > 0) out[k] = sub;
      continue;
    }

    if (!deepEqual(a, b)) out[k] = a;
  }

  return out;
};
