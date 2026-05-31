import type { DeepPartial, Schema } from "./types.js";

/**
 * Compute the smallest `DeepPartial<S>` describing what changed between
 * `before` and `after`. Designed for event payloads — records positive
 * facts (what changed) rather than `patch` instructions (which include a
 * `null` deletion sentinel).
 *
 * **Rules** (mirror `patch`'s merging rules for the *change* cases):
 * - Same reference (`Object.is`)            → omit (mirrors structural sharing)
 * - Both plain objects                      → recurse (mirrors deep merge)
 * - Otherwise (any other diff)              → set to `after[K]` (mirrors wholesale replace)
 * - Key in `before` only (missing in after) → omit
 *
 * **Round-trip property**: when `before` and `after` share the same key
 * set (the common case for event payloads against a stable state schema),
 * `patch(before, delta(before, after))` deeply equals `after`. When `after`
 * has fewer keys than `before`, the missing key is omitted from the output
 * rather than encoded as a deletion sentinel — `patch` treats the omission
 * as "no change," so the dropped key survives the round-trip. Use
 * `patch(before, { key: null })` directly if you need to express deletion
 * as an instruction; `delta` is for events.
 *
 * Equality is reference-based, matching `patch`'s structural-sharing model.
 * Two structurally-equal-but-distinct values (e.g. two `Date` instances with
 * the same `getTime()`, or two arrays with the same elements) are treated as
 * different and emit a replacement — safe semantically, just slightly less
 * compact.
 *
 * @param before - The original state object
 * @param after - The desired state object
 * @returns The smallest deep-partial that, when merged onto `before`,
 *   produces an object structurally matching `after` (modulo deletions —
 *   see the round-trip caveat above).
 */
export const delta = <S extends Schema>(
  before: Readonly<S>,
  after: Readonly<S>
): Readonly<DeepPartial<S>> => {
  if (Object.is(before, after)) return {} as DeepPartial<S>;

  const out: Record<string, unknown> = {};
  const afterKeys = Object.keys(after);

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

  return out as DeepPartial<S>;
};
