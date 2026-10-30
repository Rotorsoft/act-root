import { patch as deep_merge } from "@rotorsoft/act-patch";
import type { BroadcastState, PatchMessage } from "./types.js";

/**
 * Result of applying a patch message to cached client state.
 */
export type ApplyResult<S extends BroadcastState = BroadcastState> =
  | { ok: true; state: S }
  | { ok: false; reason: "stale" | "behind" };

/**
 * Apply a version-keyed patch message to the client's cached state.
 *
 * ## Version logic
 *
 * - All patches older than cached → "stale" (client already ahead)
 * - Gap between cached version and first patch → "behind" (client missed versions, must resync)
 * - Contiguous from cached version → apply in order
 * - No baseline (fresh client) → the genesis patch (version 0) folds onto init
 *   state; a first patch at version ≥ 1 is "behind" (can't build from init)
 * - Overlay frame ({@link PatchMessage._overlay}) at the current version →
 *   merged on top of cached state, `_v` unchanged (presence / computed
 *   fields reach caught-up clients instead of being dropped as stale)
 *
 * ## Usage (React Query)
 *
 * ```typescript
 * onData: (msg) => {
 *   const cached = utils.get_state.get_data({ streamId });
 *   const result = applyPatchMessage(msg, cached);
 *   if (result.ok) {
 *     utils.get_state.setData({ streamId }, result.state);
 *   } else if (result.reason === "behind") {
 *     utils.get_state.invalidate({ streamId }); // trigger full refetch
 *   }
 *   // "stale" → no-op, client already has newer state
 * }
 * ```
 */
export function applyPatchMessage<S extends BroadcastState>(
  msg: PatchMessage<S>,
  cached: S | null | undefined
): ApplyResult<S> {
  // A stream's first event is version 0, so a client with no baseline
  // resumes from -1; defaulting to 0 would drop that first patch as stale.
  const hasBaseline = cached != null;
  const cachedV = cached?._v ?? -1;
  // `overlay` is a non-numeric marker key, not a version — exclude it.
  const versions = Object.keys(msg)
    .map(Number)
    .filter((v) => Number.isInteger(v))
    .sort((a, b) => a - b);

  // Server-forced resync: it could not construct a patch (e.g. `overlay()`
  // found the baseline evicted), so the client must refetch. Checked before
  // anything else: a resync frame carries no versions, and the empty-frame
  // branch below would report it as `stale`, the one answer that doesn't
  // refetch.
  if (msg._resync) return { ok: false, reason: "behind" };

  // An empty frame carries nothing to apply: `stale` for a client with a
  // baseline, `behind` for one without, which must fetch one.
  if (!versions.length)
    return { ok: false, reason: hasBaseline ? "stale" : "behind" };

  const minV = versions[0];
  const maxV = versions[versions.length - 1];

  // Overlay frame: a version-neutral update (presence, computed field) at the
  // current version. Handled entirely here: the contiguous fold below would
  // apply its payload as that version's domain patch, and a client at
  // `cachedV + 1` would stamp itself caught up and never get the real one.
  if (msg._overlay) {
    // No baseline to merge onto: the client must fetch one.
    if (!cached) return { ok: false, reason: "behind" };
    // Caught up: merge on top, keeping _v (an overlay changes no version).
    if (maxV === cachedV)
      return {
        ok: true,
        state: { ...deep_merge(cached, msg[maxV]), _v: cachedV },
      };
    // Ahead by any amount: the client missed at least one domain patch.
    if (maxV > cachedV) return { ok: false, reason: "behind" };
    // Older than the baseline: genuinely stale.
    return { ok: false, reason: "stale" };
  }

  // A present baseline that already covers these versions is stale. A fresh
  // client (no baseline, cachedV = -1) can never be stale — its first
  // contiguous update is the genesis version 0.
  if (hasBaseline && maxV <= cachedV) return { ok: false, reason: "stale" };
  // A gap between the baseline (or the init floor -1) and the first patch means
  // missed versions — resync. For a fresh client this admits the genesis patch
  // (minV 0 === -1 + 1) but rejects a first patch at version >= 1, which cannot
  // be built from init state alone.
  if (minV > cachedV + 1) return { ok: false, reason: "behind" };

  // No baseline → fold the genesis patch(es) onto init state ({}).
  let state = (cached ?? {}) as S;
  for (const v of versions) {
    if (v <= cachedV) continue;
    state = { ...deep_merge(state, msg[v]), _v: v } as S;
  }
  return { ok: true, state };
}
