import type { BroadcastState, PatchMessage } from "./types.js";

/**
 * The frame that tells a client to refetch: no versions, so
 * `applyPatchMessage` always reports `behind`.
 *
 * Every producer of a resync uses this — `overlay()` on a missing baseline,
 * the cache on evicting overlay state, and the SSE backlog when it cannot
 * drop a frame without losing it silently. One factory so the shape cannot
 * drift between them.
 */
export const resync_frame = <S extends BroadcastState>(): PatchMessage<S> =>
  ({ _resync: true }) as PatchMessage<S>;
