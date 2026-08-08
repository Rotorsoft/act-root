# RFC 1434: `_resync` — a server-forced refetch frame for SSE

- **Status:** draft
- **Issue:** #1423
- **Author:** Rotorsoft
- **Created:** 2026-08-08

## Motivation

`BroadcastChannel.overlay()` does a read-modify-write against the LRU state cache. When the stream's baseline has been evicted there is nothing to modify, so the call returns `undefined` and **broadcasts nothing**.

For a live subscriber that is silent failure with no recovery. It receives neither the update nor any frame it could classify as `behind`, so it never refetches — and unlike a domain commit (which repopulates the cache via `publish`), an overlay-only stream never recovers on its own. Presence goes stale for as long as the viewer stays connected.

The defaults make this ordinary rather than exotic: `cacheSize` is 50, cache promotion happens at connect time, so a busy-but-not-committing stream ages out while fully subscribed.

Every other "the client needs to refetch" case already has a wire answer — a version gap produces `behind`. This one has no version to send, because the server no longer knows what version the stream is at. That is the gap this RFC fills.

## Public surface added

- **Public type field** — `PatchMessage._resync?: true` (`libs/act-http/src/sse/types.ts`):

  ```ts
  export type PatchMessage<S extends BroadcastState = BroadcastState> = Record<
    number,
    DeepPartial<S>
  > & { readonly _overlay?: true; readonly _resync?: true };
  ```

A `_resync` frame carries **no version entries**. `applyPatchMessage` returns `{ ok: false, reason: "behind" }` for it, which is the existing signal clients already handle by refetching a baseline. No new result shape, no new client API, no change to `publish()` or to ordinary patches.

Emitted today from exactly one place: `overlay()` on a cache miss.

## Alternatives considered

- **Status quo (silent no-op).** Rejected — this is the bug (#1423).
- **Observability only** (`onOverlayMiss`, shipped in #1431). Necessary but not sufficient: it tells the *host* something was missed, while the connected client still sits on stale presence indefinitely. Kept, alongside this.
- **Re-emit the last known state as an ordinary patch.** Impossible in the case that matters — the baseline is gone; that is the whole trigger.
- **Force a version bump so an ordinary `behind` fires.** Would fabricate a version the store never issued, corrupting the one ordering invariant the wire format has (`_v` is the store's stream version, never a counter of our own).
- **Reuse `_overlay` with no entries.** After #1419 an overlay is classified exhaustively; an entry-less overlay would need a special case *inside* that branch, which is how the #1312/#1346/#1419 family of bugs happened in the first place. A distinct marker keeps each frame kind's rule independent.
- **Grow `cacheSize` defaults instead.** Reduces frequency, doesn't remove the case, and trades a correctness bug for a memory-tuning guess.

## Stability / charter impact

- **Category:** public types (`PatchMessage` is exported from `@rotorsoft/act-http/sse`).
- **Additive.** A new *optional* field. Existing producers never set it; existing consumers that hand frames to `applyPatchMessage` get the new behavior for free. A hand-rolled client that switches on frame shape would treat an unknown frame as it always did — the field is opt-in on the read side.
- **Not a port method**, so no TCK capability flag.
- **Forward-compatible:** an older client receiving `_resync` sees a frame with no version keys. Under the pre-#1419 applicator that returns `stale` (a no-op) — the same silent-miss behavior it has today, i.e. no regression for stale clients, and correct behavior for updated ones.

## Open questions

Whether other "cannot construct a patch" cases should emit `_resync` too — a `publish()` racing a cache eviction, or a reconnect whose baseline is gone. This RFC deliberately scopes it to the one proven case (#1423); the frame kind is general enough to reuse without another surface change.
