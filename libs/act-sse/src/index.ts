/**
 * @packageDocumentation
 * @module act-sse
 *
 * Incremental state broadcast over SSE for act event-sourced apps.
 *
 * Provides server-side broadcast with domain patch forwarding,
 * an LRU state cache, presence tracking, and a client-side
 * patch applicator with version validation and resync detection.
 *
 * ## Architecture
 *
 * ```
 *   app.do() → snapshots (each carries its domain patch)
 *       │
 *       ▼
 *   deriveState(snap)          ← app-specific (overlay presence, deadlines, etc.)
 *   state._v = snap.event.version
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
 * `_v` is always the event store stream version (`snap.event.version`).
 * No separate version counters. The event store is the single source of truth.
 */

export { patch } from "@rotorsoft/act-patch";
export { applyPatchMessage } from "./apply-patch.js";
export type { ApplyResult } from "./apply-patch.js";
export { BroadcastChannel } from "./broadcast.js";
export { PresenceTracker } from "./presence.js";
export { StateCache } from "./state-cache.js";
export type { BroadcastState, PatchMessage, Subscriber } from "./types.js";
