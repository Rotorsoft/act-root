import { patch as apply_patch } from "@rotorsoft/act-patch";
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
 * const state = derive_state(snaps.at(-1));
 * broadcast.publish(stream_id, state, patches);
 *
 * // In SSE subscription:
 * const cleanup = broadcast.subscribe(stream_id, (msg) => {
 *   pending = msg;
 *   resolve?.();
 * });
 *
 * // Initial state for reconnects:
 * const cached = broadcast.get_state(stream_id);
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
  private state_cache: StateCache<S>;

  constructor(options?: { cache_size?: number }) {
    this.state_cache = new StateCache<S>(options?.cache_size ?? 50);
  }

  /**
   * Publish domain patches from a commit.
   * patches[i] corresponds to version baseV + i + 1.
   *
   * @param stream_id - The event store stream ID
   * @param state - Full state with `_v` set from `snap.event.version`
   * @param patches - Array of domain patches, one per emitted event
   */
  publish(
    stream_id: string,
    state: S,
    patches: Partial<S>[] = []
  ): PatchMessage<S> {
    this.state_cache.set(stream_id, state);

    const baseV = state._v - patches.length;
    const msg: PatchMessage<S> = {};
    patches.forEach((p, i) => {
      msg[baseV + i + 1] = p;
    });

    const subs = this.channels.get(stream_id);
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
  publish_overlay(
    stream_id: string,
    overlay_patch: Partial<S>
  ): PatchMessage<S> | undefined {
    const prev = this.state_cache.get(stream_id);
    if (!prev) return undefined;

    const state = apply_patch(prev, overlay_patch) as S;
    this.state_cache.set(stream_id, state);

    const msg: PatchMessage<S> = { [state._v]: overlay_patch };
    const subs = this.channels.get(stream_id);
    if (subs?.size) {
      for (const cb of subs) cb(msg);
    }
    return msg;
  }

  /**
   * Subscribe to broadcast messages for a stream.
   * Returns a cleanup function that removes the subscription.
   */
  subscribe(stream_id: string, cb: Subscriber<S>): () => void {
    if (!this.channels.has(stream_id)) this.channels.set(stream_id, new Set());
    this.channels.get(stream_id)!.add(cb);
    return () => {
      this.channels.get(stream_id)?.delete(cb);
      if (this.channels.get(stream_id)?.size === 0) {
        this.channels.delete(stream_id);
      }
    };
  }

  /** Get the number of subscribers for a stream. */
  get_subscriber_count(stream_id: string): number {
    return this.channels.get(stream_id)?.size ?? 0;
  }

  /** Get the cached state for a stream (for reconnects / initial SSE yield). */
  get_state(stream_id: string): S | undefined {
    return this.state_cache.get(stream_id);
  }

  /** Direct access to the state cache (for app-specific reads like presence). */
  get cache(): StateCache<S> {
    return this.state_cache;
  }
}
