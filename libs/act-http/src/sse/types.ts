import type { DeepPartial } from "@rotorsoft/act-patch";

/**
 * Base constraint for state objects managed by the broadcast system.
 * Apps extend this with their own domain state shape.
 */
export type BroadcastState = Record<string, unknown> & {
  /** Event store stream version — set by the broadcast layer from snap.event.version */
  _v: number;
};

/**
 * SSE message: version-keyed domain patches.
 * Keys are stringified version numbers, values are domain patches (deep partials).
 * Multi-event commits produce multiple version-keyed entries.
 *
 * The optional `_overlay` marker flags a version-neutral update (presence,
 * computed-field refresh) emitted by {@link BroadcastChannel.overlay} — a
 * single entry keyed at the *current* version. It tells `applyPatchMessage`
 * to merge the entry on top of the client's caught-up state instead of
 * rejecting it as stale (a same-version patch WITHOUT the marker stays
 * stale). Ordinary version-bumping patches from `publish()` omit it.
 *
 * `_resync` carries no versions at all. The server emits it when it cannot
 * construct a patch — today, when `overlay()` finds the stream's baseline
 * evicted from the LRU. A client that receives one always reports `behind`
 * and refetches. Without it the server had nothing to say in that case, so
 * live subscribers silently stopped receiving presence updates and had no
 * way to notice (#1423).
 */
export type PatchMessage<S extends BroadcastState = BroadcastState> = Record<
  number,
  DeepPartial<S>
> & { readonly _overlay?: true; readonly _resync?: true };

/**
 * Subscriber callback — receives version-keyed patch messages.
 */
export type Subscriber<S extends BroadcastState = BroadcastState> = (
  msg: PatchMessage<S>
) => void;

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
