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
 */
export type PatchMessage<S extends BroadcastState = BroadcastState> = Record<
  number,
  DeepPartial<S>
> & { readonly _overlay?: true };

/**
 * Subscriber callback — receives version-keyed patch messages.
 */
export type Subscriber<S extends BroadcastState = BroadcastState> = (
  msg: PatchMessage<S>
) => void;
