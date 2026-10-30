import { patch as apply_patch } from "@rotorsoft/act-patch";
import { StateCache } from "./state-cache.js";
import {
  type BroadcastState,
  type PatchMessage,
  resync_frame,
  type Subscriber,
} from "./types.js";

/**
 * Deliver a frame to every subscriber, containing each one: a subscriber
 * that throws must not cost the others the frame or escape into the
 * publisher. One guard around the loop would let the first throw stop it.
 *
 * @internal
 */
function fan_out<S extends BroadcastState>(
  subs: Set<Subscriber<S>> | undefined,
  msg: PatchMessage<S>,
  on_error: (error: unknown) => void
): void {
  if (!subs?.size) return;
  for (const cb of subs) {
    try {
      cb(msg);
    } catch (error) {
      on_error(error);
    }
  }
}

/**
 * Rewrite values that don't survive JSON, recursively: Sets become arrays,
 * and with `nulls`, `undefined` becomes `null`.
 *
 * `@rotorsoft/act-patch` deletes a key on either `undefined` or `null`, but
 * `JSON.stringify` drops `undefined` keys, so a cleared field would vanish
 * from the frame and a live client would keep the stale value. One walker
 * serves the frame and the cache, which differ only in that delete encoding
 * (see `wire_safe` / `cache_safe`).
 */
const normalize = <T>(value: T, nulls: boolean): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalize(v, nulls)) as T;
  // `JSON.stringify` encodes a Set as `{}`; presence (`PresenceTracker.online()`)
  // is a Set, so it would reach clients empty.
  if (value instanceof Set)
    return [...value].map((v) => normalize(v, nulls)) as T;
  // Other non-plain values (Date, Map, class instances) are left to the
  // host's serializer: a Map has no single obvious JSON encoding to guess.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = v === undefined && nulls ? null : normalize(v, nulls);
  return out as T;
};

/**
 * Frame-bound normalization: Sets become arrays, and `undefined` becomes
 * `null` so a delete survives `JSON.stringify`.
 */
const wire_safe = <T>(patch: T): T => normalize(patch, true);

/**
 * Cache-bound normalization: Sets become arrays, `undefined` is left alone,
 * because a reconnecting client reseeds from the cache and a cleared key
 * must stay absent there, not `null`.
 *
 * `Object.entries` skips the non-enumerable `OVERLAY_KEYS` marker, so
 * callers tag after normalizing.
 */
const cache_safe = <T>(state: T): T => normalize(state, false);

/**
 * Keys an `overlay()` contributed to a stream's cached state, carried on the
 * cached object itself, so `publish()` can keep them when it replaces the
 * entry: a reconnecting client reseeds at the same `_v` and couldn't tell
 * the overlay data was missing.
 *
 * A symbol keeps it off the wire, and living on the entry means it is
 * evicted with it.
 */
const OVERLAY_KEYS = Symbol("act.sse.overlay_keys");

type WithOverlayKeys = { [OVERLAY_KEYS]?: ReadonlySet<string> };

/**
 * Default `onSubscriberError`. This module shares the `sse` subpath with
 * `applyPatchMessage`, which browser code imports, so it never imports the
 * framework: a bundler would follow that into a browser build. Pass
 * `onSubscriberError` to send these to your logger.
 */
const default_subscriber_error = (error: unknown, streamId: string): void => {
  // biome-ignore lint/suspicious/noConsole: the default can't reach the framework logger (see above)
  console.error(`sse subscriber threw for "${streamId}"`, error);
};

/** Record which keys an overlay owns, accumulating across overlays. */
const tag_overlay_keys = <S extends object>(
  state: S,
  prev: S | undefined,
  keys: readonly string[]
): S => {
  const carried = (prev as WithOverlayKeys | undefined)?.[OVERLAY_KEYS];
  Object.defineProperty(state, OVERLAY_KEYS, {
    value: new Set([...(carried ?? []), ...keys]),
    enumerable: false,
    configurable: true,
  });
  return state;
};

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
 * const cached = broadcast.state(streamId);
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
  private on_subscriber_error: (error: unknown, streamId: string) => void;
  private on_overlay_miss: (streamId: string) => void;

  constructor(options?: {
    /** Max number of stream states kept in the LRU cache (default 50). */
    cacheSize?: number;
    /**
     * Called when overlay-contributed state is lost, on either of the two
     * paths that can lose it: `overlay()` finding no cached baseline, and
     * the LRU evicting an entry that carried overlay keys — the latter from
     * inside `publish()`, for a stream other than the one being published.
     *
     * Live subscribers of the affected stream are sent a resync frame, so
     * they refetch rather than keep showing state the server has forgotten.
     * The hook is observability on top of that recovery: a steady stream of
     * calls means `cacheSize` is too small for the working set.
     *
     * A throw is caught and routed to `onSubscriberError` — the resync has
     * already gone out, and a host bug must not cost the publishing stream
     * its own frame. Defaults to a no-op.
     */
    onOverlayMiss?: (streamId: string) => void;
    /**
     * Called when a subscriber callback throws. The frame is still delivered
     * to every other subscriber and the publish still returns normally — a
     * bad consumer must not break the publisher. Defaults to `console.error`;
     * pass your logger here to route it with the rest of your logs.
     */
    onSubscriberError?: (error: unknown, streamId: string) => void;
    /**
     * Deprecated alias of `cacheSize` — removal in the next major. When
     * both are given, `cacheSize` wins.
     * @deprecated use `cacheSize`
     */
    cache_size?: number;
  }) {
    this.state_cache = new StateCache<S>(
      options?.cacheSize ?? options?.cache_size ?? 50,
      (streamId, dropped) => this.on_cache_evict(streamId, dropped)
    );
    this.on_overlay_miss = options?.onOverlayMiss ?? (() => {});
    this.on_subscriber_error =
      options?.onSubscriberError ?? default_subscriber_error;
  }

  /**
   * Fan a resync out to a stream's live subscribers. `applyPatchMessage`
   * always reports `behind` for it, so they refetch.
   */
  private broadcast_resync(streamId: string): void {
    fan_out(this.channels.get(streamId), resync_frame<S>(), (error) =>
      this.on_subscriber_error(error, streamId)
    );
  }

  /**
   * The LRU dropped an entry. Overlay-contributed keys lived only in the
   * cache, so their loss is reported now, when it happens, rather than at a
   * later commit that may never come.
   */
  private on_cache_evict(streamId: string, dropped: S): void {
    if (!(dropped as S & WithOverlayKeys)[OVERLAY_KEYS]?.size) return;
    this.report_overlay_miss(streamId);
  }

  /**
   * Overlay-contributed state for `streamId` is gone. Recover first, report
   * second: the resync goes out before the host hook, and a throwing hook is
   * routed to `onSubscriberError`. Eviction runs inside `publish()` for
   * another stream, so an escaping throw would cost that stream its frame.
   */
  private report_overlay_miss(streamId: string): void {
    this.broadcast_resync(streamId);
    try {
      this.on_overlay_miss(streamId);
    } catch (error) {
      this.on_subscriber_error(error, streamId);
    }
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
    // Normalize once, so the reseed and the live frame agree. Then carry the
    // keys an `overlay()` owns across the commit, unless the new domain state
    // sets them, so presence survives a commit and the publisher still wins.
    const safe_state = cache_safe(state);
    const prev = this.state_cache.get(streamId) as
      | (S & WithOverlayKeys)
      | undefined;
    const overlay_keys = prev?.[OVERLAY_KEYS];
    let cached = safe_state;
    if (overlay_keys?.size && prev) {
      const carried = { ...safe_state } as S;
      const kept: string[] = [];
      for (const key of overlay_keys)
        if (!(key in safe_state) && key in prev) {
          (carried as Record<string, unknown>)[key] = (
            prev as Record<string, unknown>
          )[key];
          kept.push(key);
        }
      cached = tag_overlay_keys(carried, undefined, kept);
    }
    this.state_cache.set(streamId, cached);

    const baseV = state._v - patches.length;
    const msg: PatchMessage<S> = {};
    patches.forEach((p, i) => {
      msg[baseV + i + 1] = wire_safe(p);
    });

    fan_out(this.channels.get(streamId), msg, (error) =>
      this.on_subscriber_error(error, streamId)
    );
    return msg;
  }

  /**
   * Publish a state update that doesn't change the event version
   * (e.g. presence overlay, computed field refresh).
   * Uses the same version as the cached state, single entry.
   */
  overlay(
    streamId: string,
    overlay_patch: Partial<S>
  ): PatchMessage<S> | undefined {
    const prev = this.state_cache.get(streamId);
    if (!prev) {
      // No baseline to patch, and a stream that only gets overlays never
      // refills the cache, so its live clients would miss every update. A
      // resync makes them refetch. `undefined`: no overlay was broadcast.
      this.report_overlay_miss(streamId);
      return undefined;
    }

    // Normalize before patching the cache, so the reseed and the live frame
    // agree; `apply_patch` deletes on `null` as on `undefined`.
    const safe_patch = wire_safe(overlay_patch);
    const state = apply_patch(prev, safe_patch) as S;
    this.state_cache.set(
      streamId,
      tag_overlay_keys(state, prev, Object.keys(safe_patch as object))
    );

    // `_overlay: true` marks this as a version-neutral update so a caught-up
    // client applies it at the current version instead of dropping it as
    // stale (the key equals the client's cachedV). Ordinary patches omit it.
    const msg: PatchMessage<S> = {
      [state._v]: safe_patch,
      _overlay: true,
    };
    fan_out(this.channels.get(streamId), msg, (error) =>
      this.on_subscriber_error(error, streamId)
    );
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
  subscriberCount(streamId: string): number {
    return this.channels.get(streamId)?.size ?? 0;
  }

  /** Get the cached state for a stream (for reconnects / initial SSE yield). */
  state(streamId: string): S | undefined {
    return this.state_cache.get(streamId);
  }

  /** @deprecated use `overlay` — removal in the next major */
  publish_overlay(
    streamId: string,
    overlay_patch: Partial<S>
  ): PatchMessage<S> | undefined {
    return this.overlay(streamId, overlay_patch);
  }

  /** @deprecated use `subscriberCount` — removal in the next major */
  get_subscriber_count(streamId: string): number {
    return this.subscriberCount(streamId);
  }

  /** @deprecated use `state` — removal in the next major */
  get_state(streamId: string): S | undefined {
    return this.state(streamId);
  }

  /** Direct access to the state cache (for app-specific reads like presence). */
  get cache(): StateCache<S> {
    return this.state_cache;
  }
}
