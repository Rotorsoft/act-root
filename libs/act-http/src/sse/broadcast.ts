import { log } from "@rotorsoft/act";
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
 * Only the broadcast frame is normalized. Server-side state is applied
 * through `apply_patch`, which handles `undefined` natively.
 */
const wire_safe = <T>(patch: T): T => {
  if (patch === null || typeof patch !== "object") return patch;
  if (Array.isArray(patch)) return patch.map(wire_safe) as T;
  // A Set has exactly one sensible JSON encoding, and `JSON.stringify` gives
  // it the wrong one: `{}`. The framework's own `PresenceTracker.online()`
  // returns a Set and the presence recipe feeds it straight to `overlay()`,
  // so the documented way to broadcast presence shipped an empty object to
  // every client — and then froze, because a client holding `{}` treats
  // every later empty patch as a no-op (#1472).
  if (patch instanceof Set) return [...patch].map(wire_safe) as T;
  // Everything else non-plain (Date, Map, class instances) is left to
  // whatever the host's serializer already does with it. `Date` has a
  // defined encoding; `Map` does not have an unambiguous one (entries or
  // object?), so guessing would trade a visible bug for a silent choice.
  const proto = Object.getPrototypeOf(patch);
  if (proto !== Object.prototype && proto !== null) return patch;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>))
    out[k] = v === undefined ? null : wire_safe(v);
  return out as T;
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
      options?.cacheSize ?? options?.cache_size ?? 50
    );
    this.on_overlay_miss = options?.onOverlayMiss ?? (() => {});
    this.on_subscriber_error =
      options?.onSubscriberError ??
      ((error, streamId) =>
        log().error(error, `sse subscriber threw for "${streamId}"`));
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
    this.state_cache.set(streamId, state);

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
      const resync: PatchMessage<S> = { _resync: true } as PatchMessage<S>;
      fan_out(this.channels.get(streamId), resync, (error) =>
        this.on_subscriber_error(error, streamId)
      );
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
    this.state_cache.set(streamId, state);

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
