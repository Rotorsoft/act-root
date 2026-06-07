import type { DeepPartial, Schema } from "./types.js";

/**
 * Compute the smallest `DeepPartial<S>` describing what changed between
 * `before` and `after`. Designed for event payloads — records what the
 * caller put in `after`, rather than synthesizing `patch` instructions
 * on the caller's behalf.
 *
 * ## How `delta` reacts to what's in `after`
 *
 * | What the caller put in `after` for key `k` | What `delta` returns for `k` | What `patch` does on replay |
 * |---|---|---|
 * | (key omitted)                              | (key omitted)                | leaves `state[k]` alone |
 * | explicit `null` (schema permits)           | `null`                       | deletes `state[k]` (null is `patch`'s deletion sentinel) |
 * | new value                                  | the new value                | sets `state[k]` |
 * | same reference as `before[k]`              | (key omitted)                | leaves `state[k]` alone |
 *
 * The asymmetry that matters: **`delta` never *synthesizes* `null` for a
 * missing key, but it always *propagates* `null` when the caller put one
 * in `after`**. So nullable-schema actions can express a deletion as
 * `{ field: null }`, and the deletion travels through delta → event →
 * reducer-side `patch(state, event_data)` all the way to the aggregate.
 * Non-nullable schemas (no `.nullable()` fields) never see `null` in the
 * type or at runtime — the konsult case.
 *
 * ## Recursion
 *
 * - Same reference (`Object.is`)                          → omit
 * - Both plain objects                                    → recurse
 * - Any other diff (value, type, reference)               → set to `after[K]`
 * - Key in `before` only (missing in `after`)             → omit
 * - Key in `after` only, or explicit `null` in `after`    → set to `after[K]` (so an explicit `null` flows through)
 *
 * ## Round-trip property
 *
 * `patch(before, delta(before, after))` deeply equals `after` when the
 * key set in `after` is a superset of the key set in `before` (or the
 * shrinkages are encoded as explicit nulls in `after`). If `after`
 * silently *omits* keys that were present in `before`, the dropped key
 * survives the round-trip — `delta` reads the omission as "no change,"
 * not "delete." Express deletion in `after` (as `null`) or instruct
 * `patch` directly (`patch(before, { key: null })`).
 *
 * Equality is reference-based, matching `patch`'s structural-sharing model.
 * Two structurally-equal-but-distinct values (e.g. two `Date` instances with
 * the same `getTime()`, or two arrays with the same elements) are treated as
 * different and emit a replacement — safe semantically, just slightly less
 * compact.
 *
 * @param before - The original state object
 * @param after - The desired state object
 * @returns The smallest deep-partial describing what `after` says changed
 *   relative to `before`. May contain `null` only when `after` itself
 *   contained `null` at the same path.
 */
export const delta = <S extends Schema>(
  before: Readonly<S>,
  after: Readonly<S>
): Readonly<DeepPartial<S>> => {
  if (Object.is(before, after)) return {} as DeepPartial<S>;

  const out: Record<string, unknown> = {};
  const after_keys = Object.keys(after);

  for (let i = 0; i < after_keys.length; i++) {
    const k = after_keys[i];
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
