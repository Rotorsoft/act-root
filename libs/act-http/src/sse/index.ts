/**
 * @packageDocumentation
 * @module act-http/sse
 *
 * Incremental state broadcast over SSE for act event-sourced apps.
 *
 * Server-side broadcast with domain patch forwarding, an LRU state cache,
 * presence tracking, and a client-side patch applicator with version
 * validation and resync detection.
 *
 * ## Architecture
 *
 * ```
 *   app.do() → snapshots (each carries its domain patch)
 *       │
 *       ▼
 *   deriveState(snap)          ← app-specific (overlay presence, deadlines, etc.)
 *   state._v = snap.version    (+ an empty patch if .snap took a version)
 *       │
 *       ▼
 *   broadcast.publish(streamId, state, patches)
 *       │
 *       ├── version-key each patch: { [baseV+1]: patch1, [baseV+2]: patch2 }
 *       └── push to all SSE subscribers
 *       │
 *       ▼
 *   Client: applyPatchMessage(msg, cached)
 *       │
 *       ├── contiguous → deep-merge patches in version order
 *       ├── stale    → skip (client already ahead)
 *       └── behind   → resync (client missed versions)
 * ```
 *
 * ## Version Contract
 *
 * `_v` is always the event store stream version at the head (`snap.version`).
 * No separate version counters. The event store is the single source of truth.
 * A `.snap` takes a version of its own, so `snap.version` is then one past
 * `snap.event.version`: publish it as an empty patch, or the next commit
 * reads as a gap and every live client resyncs.
 */

export { patch } from "@rotorsoft/act-patch";
export type { ApplyResult } from "./apply-patch.js";
export { applyPatchMessage } from "./apply-patch.js";
export { BroadcastChannel } from "./broadcast.js";
export { PresenceTracker } from "./presence.js";
export { StateCache } from "./state-cache.js";
export type { BroadcastState, PatchMessage, Subscriber } from "./types.js";
