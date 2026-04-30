import type { Patch, Schema } from "./types.js";

/**
 * Compute the smallest `Patch<S>` that, when applied to `before` via `patch()`,
 * yields an object semantically equal to `after`. The semantic inverse of `patch()`.
 *
 * **Round-trip guarantee:**
 *   `patch(before, delta(before, after))` deeply equals `after`.
 *
 * **Rules** (mirror `patch`'s merging rules):
 * - Same reference (`Object.is`)                → omit (mirrors structural sharing)
 * - Both plain objects                          → recurse (mirrors deep merge)
 * - Otherwise (any other diff)                  → set to `after[K]` (mirrors wholesale replace)
 * - Key in `before` only                        → set to `null` (mirrors delete)
 *
 * Equality is reference-based, matching `patch`'s structural-sharing model.
 * Two structurally-equal-but-distinct values (e.g. two `Date` instances with the
 * same `getTime()`, or two arrays with the same elements) are treated as
 * different and emit a replacement — safe for the round-trip identity, just
 * slightly less compact.
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

  const out: Record<string, unknown> = {};
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

    out[k] = a;
  }

  return out as Patch<S>;
};
