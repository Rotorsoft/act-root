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
  // Distinguish an *absent* baseline from a real version-0 baseline (#1346).
  // Act assigns the first event of any stream `version = 0`, so a fresh client
  // (no cache) must resume from a pre-baseline watermark of -1 — otherwise the
  // `?? 0` default collides with a genuine version-0 genesis patch and drops
  // it as "stale". A present baseline keeps its own `_v`.
  const hasBaseline = cached != null;
  const cachedV = cached?._v ?? -1;
  // `overlay` is a non-numeric marker key, not a version — exclude it.
  const versions = Object.keys(msg)
    .map(Number)
    .filter((v) => Number.isInteger(v))
    .sort((a, b) => a - b);

  if (!versions.length) return { ok: false, reason: "stale" };

  const minV = versions[0];
  const maxV = versions[versions.length - 1];

  // Overlay frame: a version-neutral update (presence, computed field) at the
  // current version. A caught-up client (maxV === cachedV) merges it on top
  // of its state, keeping _v. Older (maxV < cachedV) is genuinely stale; a
  // gap ahead (maxV > cachedV) means the client is behind — both fall through
  // to the normal logic below.
  if (msg._overlay && cached && maxV === cachedV) {
    return {
      ok: true,
      state: { ...deep_merge(cached, msg[maxV]), _v: cachedV },
    };
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
