import type { Operation } from "fast-json-patch";

/**
 * Base constraint for state objects managed by the broadcast system.
 * Apps extend this with their own domain state shape.
 */
export type BroadcastState = Record<string, unknown> & {
  /** Event store stream version — set by the broadcast layer from snap.event.version */
  _v: number;
};

/**
 * Full state message — sent on initial connect, resync, or when patch is too large.
 */
export type FullStateMessage<S extends BroadcastState = BroadcastState> = S & {
  _type: "full";
  serverTime: string;
};

/**
 * Incremental patch message — sent when the diff is small enough.
 * Client applies RFC 6902 operations to its cached state at _baseV to reach _v.
 */
export type PatchMessage = {
  _type: "patch";
  /** Target version after applying the patch */
  _v: number;
  /** Version the patch applies to (client must have this version cached) */
  _baseV: number;
  /** RFC 6902 JSON Patch operations */
  _patch: Operation[];
  serverTime: string;
};

/**
 * Discriminated union sent over SSE — client switches on `_type`.
 */
export type BroadcastMessage<S extends BroadcastState = BroadcastState> =
  | FullStateMessage<S>
  | PatchMessage;

/**
 * Subscriber callback — receives either a patch or full state message.
 */
export type Subscriber<S extends BroadcastState = BroadcastState> = (
  msg: BroadcastMessage<S>
) => void;

/**
 * Options for creating a broadcast channel.
 */
export type BroadcastOptions = {
  /** Max RFC 6902 operations before falling back to full state (default: 50) */
  maxPatchOps?: number;
};
