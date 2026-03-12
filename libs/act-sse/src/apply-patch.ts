import { applyPatch } from "fast-json-patch";
import type { BroadcastMessage, BroadcastState } from "./types.js";

/**
 * Result of applying a broadcast message to cached client state.
 */
export type ApplyResult<S extends BroadcastState = BroadcastState> =
  | { ok: true; state: S }
  | { ok: false; reason: "stale" | "behind" | "patch-failed" };

/**
 * Apply a broadcast message to the client's cached state.
 *
 * Handles both full state and incremental patches with version validation.
 * Returns the new state on success, or a failure reason that the client
 * can use to decide whether to resync.
 *
 * ## Version logic
 *
 * - **Full state**: accepted if `msg._v >= cachedV` (or no cached state)
 * - **Patch**:
 *   - `_baseV < cachedV` → "stale" (client ahead, skip — mutation response arrived first)
 *   - `_baseV > cachedV` → "behind" (client missed a version, must resync)
 *   - `_baseV === cachedV` → apply patch ops
 *
 * ## Usage (React Query)
 *
 * ```typescript
 * onData: (msg) => {
 *   const cached = utils.getState.getData({ streamId });
 *   const result = applyBroadcastMessage(msg, cached);
 *   if (result.ok) {
 *     utils.getState.setData({ streamId }, result.state);
 *   } else if (result.reason === "behind") {
 *     utils.getState.invalidate({ streamId }); // trigger full refetch
 *   }
 *   // "stale" → no-op, client already has newer state
 * }
 * ```
 */
export function applyBroadcastMessage<S extends BroadcastState>(
  msg: BroadcastMessage<S>,
  cached: S | null | undefined
): ApplyResult<S> {
  const cachedV = cached?._v ?? 0;

  if (msg._type === "full") {
    if (msg._v < cachedV) return { ok: false, reason: "stale" };
    // Strip _type from the state stored in cache
    const { _type, ...state } = msg;
    return { ok: true, state: state as S };
  }

  // Patch message
  if (msg._baseV < cachedV) return { ok: false, reason: "stale" };
  if (msg._baseV > cachedV) return { ok: false, reason: "behind" };

  // _baseV === cachedV — apply
  if (!cached) return { ok: false, reason: "behind" };

  try {
    const clone = structuredClone(cached);
    applyPatch(clone, msg._patch, true); // mutates clone in-place, throws on validation failure
    clone._v = msg._v;
    return { ok: true, state: clone };
  } catch {
    return { ok: false, reason: "patch-failed" };
  }
}
