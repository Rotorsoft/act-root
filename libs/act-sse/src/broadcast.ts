import { compare } from "fast-json-patch";
import { StateCache } from "./state-cache.js";
import type {
  BroadcastMessage,
  BroadcastOptions,
  BroadcastState,
  Subscriber,
} from "./types.js";

const DEFAULT_MAX_PATCH_OPS = 50;

/**
 * Server-side broadcast channel for incremental state sync over SSE.
 *
 * Manages per-stream subscriber sets and an LRU state cache. When state
 * changes, computes an RFC 6902 JSON Patch against the previous cached
 * state and pushes either a patch (small diff) or full state (large diff
 * or first broadcast) to all subscribers.
 *
 * ## Usage
 *
 * ```typescript
 * const broadcast = new BroadcastChannel<MyState>();
 *
 * // After every app.do():
 * const snap = await doAction(...);
 * const state = deriveState(snap);       // app-specific state derivation
 * broadcast.publish(streamId, state);    // computes patch + pushes to SSE
 *
 * // In SSE subscription:
 * const cleanup = broadcast.subscribe(streamId, (msg) => {
 *   pending = msg;
 *   resolve?.();
 * });
 *
 * // Initial state for reconnects:
 * const cached = broadcast.getState(streamId);
 * if (cached) yield { _type: "full", ...cached, serverTime: ... };
 * ```
 *
 * ## Version Contract
 *
 * The `_v` field on state MUST be set from `snap.event.version` (the event
 * store's monotonic stream version) BEFORE calling `publish()`. This is the
 * single source of truth for ordering — no separate version counters.
 */
export class BroadcastChannel<S extends BroadcastState = BroadcastState> {
  private channels = new Map<string, Set<Subscriber<S>>>();
  private stateCache: StateCache<S>;
  private maxPatchOps: number;

  constructor(options?: BroadcastOptions & { cacheSize?: number }) {
    this.stateCache = new StateCache<S>(options?.cacheSize ?? 50);
    this.maxPatchOps = options?.maxPatchOps ?? DEFAULT_MAX_PATCH_OPS;
  }

  /**
   * Publish new state for a stream. Computes a patch against the previously
   * cached state and pushes to all subscribers.
   *
   * @param streamId - The event store stream ID
   * @param state - Full state with `_v` set from `snap.event.version`
   * @returns The broadcast message that was sent (or undefined if no subscribers and no cache change)
   */
  publish(streamId: string, state: S): BroadcastMessage<S> {
    const prev = this.stateCache.get(streamId);
    this.stateCache.set(streamId, state);

    const msg = this.computeMessage(prev, state);
    const subs = this.channels.get(streamId);
    if (subs?.size) {
      for (const cb of subs) cb(msg);
    }
    return msg;
  }

  /**
   * Publish a state update that doesn't change the event version
   * (e.g. presence overlay, computed field refresh).
   * Uses the same version as the cached state for _baseV and _v.
   */
  publishOverlay(streamId: string, state: S): BroadcastMessage<S> | undefined {
    const prev = this.stateCache.get(streamId);
    if (!prev) return undefined;

    this.stateCache.set(streamId, state);

    const msg = this.computeMessage(prev, state);
    const subs = this.channels.get(streamId);
    if (subs?.size) {
      for (const cb of subs) cb(msg);
    }
    return msg;
  }

  /**
   * Subscribe to broadcast messages for a stream.
   * Returns a cleanup function that removes the subscription.
   */
  subscribe(streamId: string, cb: Subscriber<S>): () => void {
    if (!this.channels.has(streamId)) this.channels.set(streamId, new Set());
    this.channels.get(streamId)!.add(cb);
    return () => {
      this.channels.get(streamId)?.delete(cb);
      if (this.channels.get(streamId)?.size === 0) {
        this.channels.delete(streamId);
      }
    };
  }

  /** Get the number of subscribers for a stream. */
  getSubscriberCount(streamId: string): number {
    return this.channels.get(streamId)?.size ?? 0;
  }

  /** Get the cached state for a stream (for reconnects / initial SSE yield). */
  getState(streamId: string): S | undefined {
    return this.stateCache.get(streamId);
  }

  /** Direct access to the state cache (for app-specific reads like presence). */
  get cache(): StateCache<S> {
    return this.stateCache;
  }

  // --- internals ---

  private computeMessage(prev: S | undefined, next: S): BroadcastMessage<S> {
    const serverTime = new Date().toISOString();

    if (!prev) {
      return { _type: "full", ...next, serverTime };
    }

    const ops = compare(prev, next);
    if (ops.length === 0) {
      // No actual diff — still send full state so subscribers get serverTime refresh
      return { _type: "full", ...next, serverTime };
    }
    if (ops.length > this.maxPatchOps) {
      return { _type: "full", ...next, serverTime };
    }

    return {
      _type: "patch",
      _v: next._v,
      _baseV: prev._v,
      _patch: ops,
      serverTime,
    };
  }
}
