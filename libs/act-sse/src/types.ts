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
 */
export type PatchMessage<S extends BroadcastState = BroadcastState> = Record<
  number,
  DeepPartial<S>
>;

/**
 * Subscriber callback — receives version-keyed patch messages.
 */
export type Subscriber<S extends BroadcastState = BroadcastState> = (
  msg: PatchMessage<S>
) => void;
