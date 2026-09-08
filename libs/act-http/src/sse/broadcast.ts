import { patch as apply_patch } from "@rotorsoft/act-patch";
import { StateCache } from "./state-cache.js";
import {
  type BroadcastState,
  type PatchMessage,
  resync_frame,
  type Subscriber,
} from "./types.js";

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
/**
 * Deliver a frame to every subscriber, containing each one individually.
 *
 * SSE subscribers are the least-trusted callbacks in the system — one per
 * connection, driven by network state. The unguarded loop this replaces let
 * the first thrower abort iteration, so every later subscriber lost the
 * frame and the exception escaped into the host's commit path (#1423). Same
 * containment principle the orchestrator applies to lifecycle listeners.
 * Guarding each callback rather than the loop is the point: one guard around
 * the whole loop would still let the first throw suppress the rest.
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
 * Rewrite `undefined`-valued keys to `null`, recursively.
 *
 * `@rotorsoft/act-patch` treats `undefined` and `null` as the same delete
 * signal, but `JSON.stringify` drops `undefined`-valued keys entirely — and
 * every SSE transport serializes frames as JSON. A reducer that clears a
 * field the idiomatic way (`{ left: undefined }`) therefore produced a frame
 * with no mention of `left` at all, so a live client kept the stale value
 * while stamping the new version — believing itself caught up, and never
 * refetching (#1471).
 *
 * `null` reaches the same `delete` branch in the patch applicator and
 * survives JSON, so normalizing here makes the two spellings equivalent on
 * the wire as they already are in memory.
 *
 * One walker serves both destinations. The frame and the cached state
 * agree on every encoding except the delete: see `wire_safe` /
 * `cache_safe` below.
 */
const normalize = <T>(value: T, nulls: boolean): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalize(v, nulls)) as T;
  // A Set has exactly one sensible JSON encoding, and `JSON.stringify` gives
  // it the wrong one: `{}`. The framework's own `PresenceTracker.online()`
  // returns a Set and the presence recipe feeds it straight to `overlay()`,
  // so the documented way to broadcast presence shipped an empty object to
  // every client — and then froze, because a client holding `{}` treats
  // every later empty patch as a no-op (#1472).
  if (value instanceof Set)
    return [...value].map((v) => normalize(v, nulls)) as T;
  // Everything else non-plain (Date, Map, class instances) is left to
  // whatever the host's serializer already does with it. `Date` has a
  // defined encoding; `Map` does not have an unambiguous one (entries or
  // object?), so guessing would trade a visible bug for a silent choice.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = v === undefined && nulls ? null : normalize(v, nulls);
  return out as T;
};

/**
 * Frame-bound normalization: Sets become arrays, and `undefined` becomes
 * `null` so a delete survives `JSON.stringify` (#1471).
 */
const wire_safe = <T>(patch: T): T => normalize(patch, true);

/**
 * Cache-bound normalization: Sets become arrays, `undefined` is left alone.
 *
 * The cached state is what a reconnecting client reseeds from, and #1471
 * settled that it must keep a cleared key *absent* rather than `null`, so
 * the wire's delete encoding is exactly the part the cache must not adopt.
 * That single difference is why `nulls` is a parameter instead of two
 * separate walkers — a second copy would drift the moment either side grew
 * a case.
 *
 * Non-enumerable properties are invisible to `Object.entries`, so the
 * `OVERLAY_KEYS` marker is neither copied nor clobbered here; callers tag
 * after normalizing.
 */
const cache_safe = <T>(state: T): T => normalize(state, false);

/**
 * Keys an `overlay()` contributed to a stream's cached state, carried on the
 * cached object itself.
 *
 * `publish()` replaces the cache entry with host-derived state, so overlay
 * data — presence, computed fields — vanished from the cache while live
 * clients, which had already applied the overlay frame, kept it. A
 * reconnecting client then reseeded WITHOUT it and had no way to notice: its
 * `_v` matches the server's, so nothing classifies as `behind` (#1473).
 *
 * A symbol keeps this out of `Object.keys`, `JSON.stringify` and therefore
 * off the wire; living on the cached object means it is evicted with the
 * entry rather than needing a parallel structure to prune.
 */
const OVERLAY_KEYS = Symbol("act.sse.overlay_keys");

type WithOverlayKeys = { [OVERLAY_KEYS]?: ReadonlySet<string> };

/**
 * Default `onSubscriberError` — routes through the framework logger, so a
 * throwing subscriber lands wherever the host already sends framework logs.
 *
 * The logger is reached through a dynamic import on purpose. This module sits
 * in the `sse` subpath alongside `applyPatchMessage` and the wire types, which
 * browser code imports; a static `import { log } from "@rotorsoft/act"` puts
 * the whole framework in that bundle, and the framework builds an
 * `AsyncLocalStorage` the moment it loads — a Node API the browser stubs out
 * and throws on. Only a server ever constructs a `BroadcastChannel`, so this
 * path never runs client-side, and the import stays out of the static graph
 * where the bundler would follow it.
 */
const default_subscriber_error = (error: unknown, streamId: string): void => {
  void import("@rotorsoft/act").then(({ log }) =>
    log().error(error, `sse subscriber threw for "${streamId}"`)
  );
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

export class BroadcastChannel<S extends BroadcastState = BroadcastState> {
  private channels = new Map<string, Set<Subscriber<S>>>();
  private state_cache: StateCache<S>;

  /**
   * @param options.cacheSize - Max number of stream states kept in the LRU
   * cache (default 50).
   */
  private on_subscriber_error: (error: unknown, streamId: string) => void;
  private on_overlay_miss: (streamId: string) => void;

  constructor(options?: {
    cacheSize?: number;
    /**
     * Called when `overlay()` finds no cached baseline for the stream, so
     * the update cannot be broadcast. Live subscribers receive nothing and
     * have no way to notice — a host that cares should raise `cacheSize`,
     * re-`publish` the stream, or push the viewers to refetch. Defaults to a
     * no-op so existing behavior is unchanged apart from being observable.
     */
    onOverlayMiss?: (streamId: string) => void;
    /**
     * Called when a subscriber callback throws. The frame is still delivered
     * to every other subscriber and the publish still returns normally — a
     * bad consumer must not break the publisher (#1423). Defaults to the
     * framework's `log()` port, so it lands wherever the host already
     * routes framework logs.
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
   * The LRU dropped an entry. If it carried overlay-contributed keys, that
   * data existed only in the cache and is now gone: a later `publish()` has
   * no baseline to carry it from, and the reseed a reconnecting client gets
   * would silently lack presence a live client is still showing (#1648).
   *
   * `overlay()` was hardened for the same loss on its own path (#1423);
   * catching it here covers `publish()` too, and does it at the moment the
   * data is lost rather than at a later commit that may never come. Reading
   * the marker off the entry being evicted is what avoids the parallel
   * bookkeeping structure the `OVERLAY_KEYS` design explicitly rejected.
   */
  private on_cache_evict(streamId: string, dropped: S): void {
    if (!(dropped as S & WithOverlayKeys)[OVERLAY_KEYS]?.size) return;
    this.on_overlay_miss(streamId);
    this.broadcast_resync(streamId);
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
    // Carry overlay-contributed keys across the commit (#1473). Only keys
    // an `overlay()` actually owns, and only when the new domain state does
    // not speak to them — so a publisher that drops or overwrites a key
    // still wins, and presence survives a commit as the docs imply.
    // Normalize once, up front: the cache entry and the frame are both
    // derived from this, so the reseed a reconnecting client gets cannot
    // disagree with what a live client applied (#1646). `overlay()` already
    // normalized before its own cache write; `publish()` did not, so a Set
    // shipped as an array live and as `{}` on reseed — and then froze.
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
      // No baseline to read-modify-write, so nothing is broadcast — and
      // because no frame is emitted there is nothing for a live client to
      // classify as `behind`, so it never refetches either. Unlike a domain
      // commit (which repopulates the cache via `publish`), an overlay-only
      // stream never recovers. The defaults make this reachable rather than
      // exotic: `cacheSize` is 50 while a host may hold far more live
      // subscriptions, and cache promotion happens at connect time, so a
      // busy-but-not-committing stream ages out while fully subscribed.
      //
      // Emit a resync frame so live subscribers refetch instead of silently
      // missing the update forever (#1423). `on_overlay_miss` still fires so
      // a host can count these — a steady stream of them means `cacheSize`
      // is too small for the working set.
      this.on_overlay_miss(streamId);
      this.broadcast_resync(streamId);
      // Still `undefined`: no overlay state was produced, and callers use the
      // return value as "the patch I broadcast", which a resync is not.
      return undefined;
    }

    // Normalize BEFORE applying to the cache, so a reconnecting client's
    // reseed and a live client's frame agree (#1472). `apply_patch` treats
    // `null` and `undefined` as the same delete signal, so normalizing first
    // does not change the delete semantics — it only fixes the encodings
    // that would not survive JSON.
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
