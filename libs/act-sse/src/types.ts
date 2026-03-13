/**
 * Base constraint for state objects managed by the broadcast system.
 * Apps extend this with their own domain state shape.
 */
export type BroadcastState = Record<string, unknown> & {
  /** Event store stream version — set by the broadcast layer from snap.event.version */
  _v: number;
};

/**
 * Recursive deep partial — mirrors act core's Patch<T>.
 */

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, any> ? DeepPartial<T[K]> : T[K];
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
