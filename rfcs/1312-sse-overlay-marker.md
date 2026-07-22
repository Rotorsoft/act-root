# RFC 1312: SSE overlay frames carry a marker so live clients apply them

- **Status:** draft
- **Issue:** #1312
- **Author:** debug-wave
- **Created:** 2026-07-22

## Motivation

`@rotorsoft/act-http/sse` lets a host push two kinds of state update to
subscribers: version-bumping **patches** (one per committed event) and
version-neutral **overlays** — presence ("alice is online"), computed-field
refreshes, anything with no backing event. The docs (`real-time.md` §
Overlays / § Presence) tell you to push presence via `broadcast.overlay(...)`
and to consume every frame on the client via `applyPatchMessage`.

Those two halves are incompatible today. `overlay()` emits a patch keyed at
the *current, unchanged* stream version (`{ [state._v]: patch }`), and
`applyPatchMessage` treats any message whose highest version `<= cachedV` as
`stale` → no-op. A live client that is caught up has `cached._v === state._v`,
so the overlay's key equals `cachedV` and is **always dropped**. The overlay
still updates the server LRU cache, so a *reconnecting* client sees it in the
baseline — but the already-connected viewers, the whole point of presence,
never do. It only surfaces when a later real event bumps `_v` and happens to
carry the overlaid field along.

The root cause is that a same-version overlay is byte-for-byte
indistinguishable from a genuinely stale patch a client already applied. The
applicator cannot tell "apply this presence update on top of your current
state" from "ignore, you're ahead" without a signal on the frame.

## Public surface added

- **Public type field** — `PatchMessage<S>` gains an optional
  `readonly _overlay?: true` marker. Ordinary version-bumping patches from
  `publish()` omit it; `overlay()` sets it.
- **Changed semantics (additive)** — `applyPatchMessage(msg, cached)`: when
  `msg._overlay` is set and the overlay's version equals `cachedV`, it now
  deep-merges the overlay into the cached state and returns
  `{ ok: true, state }` with `_v` unchanged, instead of `{ ok: false,
  reason: "stale" }`. Every message **without** the marker keeps its exact
  current behavior — a same-version *non-overlay* message is still `stale`.

No new exports, builder methods, port methods, or lifecycle events. The marker
rides inside the existing `kind: "patch"` SSE frame, so the generated
`trpc` / `hono` SSE transports need no change — they already forward the
`PatchMessage` payload verbatim.

## Alternatives considered

- **Do nothing.** Rejected — the documented presence flow silently loses every
  live update; the bug (#1312) is a real data-visibility defect, not a doc nit.
- **Bump `_v` on overlays.** Simplest, but rejected outright: `real-time.md`
  Key Rule 1 makes `_v === snap.event.version` the single source of truth, and
  presence explicitly must not pollute the event log. A broadcast-layer version
  bump would desync the client's `_v` from the store's stream version and break
  the contiguity math for real patches.
- **A distinct `kind: "overlay"` SSE frame end-to-end.** Cleaner wire
  semantics, but strictly larger: the wiring (`api/sse-wiring.ts`) and the
  `trpc` / `hono` generators would each grow a third frame kind and a client
  handler branch. Crucially, the wiring receives frames from
  `broadcast.subscribe(streamId, cb)` as a `PatchMessage` — so it would *still*
  need a marker on the message to know a frame is an overlay. The marker is the
  necessary core; the distinct kind is optional polish that can be layered on
  later without another breaking change. Deferred.
- **A separate `applyOverlayMessage` function + separate subscription
  channel.** Doubles the client API surface and the server fan-out for a
  same-shaped payload. Rejected in favor of one applicator that reads the
  marker.

## Stability / charter impact

- **Category:** public types (`PatchMessage`) + the documented runtime behavior
  of `applyPatchMessage`, both in the `@rotorsoft/act-http/sse` subpath.
- **Additive, not breaking.** The `overlay?` field is optional; existing
  producers that never set it are unaffected. `applyPatchMessage`'s behavior is
  unchanged for every message without the marker — a same-version *non-overlay*
  message is still `stale`, an older overlay is still `stale`, a gap is still
  `behind`. The only new outcome is "marked overlay at the current version →
  applied." No `BREAKING CHANGE:` footer needed.
- **No port method**, so no TCK / adapter work. This is a leaf-package
  (`act-http`) change; core is untouched.
- The existing `apply-patch.spec.ts` "same version" case, which currently pins
  the *drop* (asserts `stale`), flips to assert the overlay is applied — and a
  behavior-contract row lands so the guarantee has a standing test.

## Open questions

None blocking. A follow-up may surface overlays as a distinct `kind: "overlay"`
frame on the generated transports for hosts that want to branch on it
explicitly; this RFC deliberately keeps that out of scope since the marker
already fixes the live-client drop with the smallest surface.
