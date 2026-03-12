/**
 * @packageDocumentation
 * @module act-sse
 *
 * Incremental state broadcast over SSE for act event-sourced apps.
 *
 * Provides server-side broadcast with automatic RFC 6902 JSON Patch
 * computation, an LRU state cache, presence tracking, and a client-side
 * patch applicator with version validation and resync detection.
 *
 * ## Architecture
 *
 * ```
 *   app.do() → snap
 *       │
 *       ▼
 *   deriveState(snap)          ← app-specific (overlay presence, deadlines, etc.)
 *   state._v = snap.event.version
 *       │
 *       ▼
 *   broadcast.publish(streamId, state)
 *       │
 *       ├── compare(prev, state) → RFC 6902 ops
 *       ├── if ops ≤ threshold → PatchMessage { _baseV, _v, _patch }
 *       ├── if ops > threshold → FullStateMessage { _v, ...state }
 *       └── push to all SSE subscribers
 *       │
 *       ▼
 *   Client: applyBroadcastMessage(msg, cached)
 *       │
 *       ├── full  → accept if _v ≥ cachedV
 *       ├── patch → apply if _baseV === cachedV
 *       ├── stale → skip (_baseV < cachedV, mutation response arrived first)
 *       └── behind → resync (_baseV > cachedV, client missed a version)
 * ```
 *
 * ## Version Contract
 *
 * `_v` is always the event store stream version (`snap.event.version`).
 * No separate version counters. The event store is the single source of truth.
 */

export { applyBroadcastMessage } from "./apply-patch.js";
export type { ApplyResult } from "./apply-patch.js";
export { BroadcastChannel } from "./broadcast.js";
export { PresenceTracker } from "./presence.js";
export { StateCache } from "./state-cache.js";
export type {
  BroadcastMessage,
  BroadcastOptions,
  BroadcastState,
  FullStateMessage,
  PatchMessage,
  Subscriber,
} from "./types.js";
