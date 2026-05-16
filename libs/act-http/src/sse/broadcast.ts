import { patch as applyPatch } from "@rotorsoft/act-patch";
import { StateCache } from "./state-cache.js";
import type { BroadcastState, PatchMessage, Subscriber } from "./types.js";

/**
 * Server-side broadcast channel for incremental state sync over SSE.
 *
 * Manages per-stream subscriber sets and an LRU state cache. When state
 * changes, forwards domain patches (from event handlers) to all subscribers
 * as version-keyed messages.
 *
 * ## Usage
 *
 * ```typescript
 * const broadcast = new BroadcastChannel<MyState>();
 *
 * // After every app.do():
 * const snaps = await app.do(...);
 * const patches = snaps.map(s => s.patch).filter(Boolean);
 * const state = deriveState(snaps.at(-1));
 * broadcast.publish(streamId, state, patches);
 *
 * // In SSE subscription:
 * const cleanup = broadcast.subscribe(streamId, (msg) => {
 *   pending = msg;
 *   resolve?.();
 * });
 *
 * // Initial state for reconnects:
 * const cached = broadcast.getState(streamId);
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

  constructor(options?: { cacheSize?: number }) {
    this.stateCache = new StateCache<S>(options?.cacheSize ?? 50);
  }

  /**
   * Publish domain patches from a commit.
   * patches[i] corresponds to version baseV + i + 1.
   *
   * @param streamId - The event store stream ID
   * @param state - Full state with `_v` set from `snap.event.version`
   * @param patches - Array of domain patches, one per emitted event
   */
  publish(
    streamId: string,
    state: S,
    patches: Partial<S>[] = []
  ): PatchMessage<S> {
    this.stateCache.set(streamId, state);

    const baseV = state._v - patches.length;
    const msg: PatchMessage<S> = {};
    patches.forEach((p, i) => {
      msg[baseV + i + 1] = p;
    });

    const subs = this.channels.get(streamId);
    if (subs?.size) {
      for (const cb of subs) cb(msg);
    }
    return msg;
  }

  /**
   * Publish a state update that doesn't change the event version
   * (e.g. presence overlay, computed field refresh).
   * Uses the same version as the cached state, single entry.
   */
  publishOverlay(
    streamId: string,
    overlayPatch: Partial<S>
  ): PatchMessage<S> | undefined {
    const prev = this.stateCache.get(streamId);
    if (!prev) return undefined;

    const state = applyPatch(prev, overlayPatch) as S;
    this.stateCache.set(streamId, state);

    const msg: PatchMessage<S> = { [state._v]: overlayPatch };
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
}
