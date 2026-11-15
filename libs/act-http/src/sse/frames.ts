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

/**
 * Whether a frame carries no versions, so `applyPatchMessage` can never
 * classify it as a gap.
 *
 * A version-keyed patch that goes missing is self-announcing: the next frame
 * skips a version and the client refetches. An `_overlay` or `_resync` frame
 * is not, which is why anything that drops frames has to tell them apart.
 */
export const is_version_neutral = <S extends BroadcastState>(
  msg: PatchMessage<S>
): boolean => msg._overlay === true || msg._resync === true;
