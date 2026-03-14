import { patch as deepMerge } from "@rotorsoft/act-patch";
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
 *
 * ## Usage (React Query)
 *
 * ```typescript
 * onData: (msg) => {
 *   const cached = utils.getState.getData({ streamId });
 *   const result = applyPatchMessage(msg, cached);
 *   if (result.ok) {
 *     utils.getState.setData({ streamId }, result.state);
 *   } else if (result.reason === "behind") {
 *     utils.getState.invalidate({ streamId }); // trigger full refetch
 *   }
 *   // "stale" → no-op, client already has newer state
 * }
 * ```
 */
export function applyPatchMessage<S extends BroadcastState>(
  msg: PatchMessage<S>,
  cached: S | null | undefined
): ApplyResult<S> {
  const cachedV = cached?._v ?? 0;
  const versions = Object.keys(msg)
    .map(Number)
    .sort((a, b) => a - b);

  if (!versions.length) return { ok: false, reason: "stale" };

  const minV = versions[0];
  const maxV = versions[versions.length - 1];

  // All patches are older than what we have
  if (maxV <= cachedV) return { ok: false, reason: "stale" };
  // Gap — we missed versions
  if (!cached || minV > cachedV + 1) return { ok: false, reason: "behind" };

  // Apply patches in version order, skipping any we already have
  let state = cached;
  for (const v of versions) {
    if (v <= cachedV) continue; // already applied
    state = { ...deepMerge(state, msg[v]), _v: v } as S;
  }
  return { ok: true, state };
}
