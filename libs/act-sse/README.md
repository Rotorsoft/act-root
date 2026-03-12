# @rotorsoft/act-sse

Incremental state broadcast over SSE for [act](https://github.com/rotorsoft/act-root) event-sourced apps.

Instead of sending the full aggregate state to every connected client after each action, `act-sse` computes RFC 6902 JSON Patches between consecutive states and sends only the diff — falling back to full state when the patch is too large or the client needs to resync.

## Install

```bash
npm install @rotorsoft/act-sse
# or
pnpm add @rotorsoft/act-sse
```

## Architecture

```
  app.do() → snap
      │
      ▼
  deriveState(snap)              ← app-specific (overlay presence, deadlines, etc.)
  state._v = snap.event.version  ← event store version is the single source of truth
      │
      ▼
  broadcast.publish(streamId, state)
      │
      ├── compare(prev, state) → RFC 6902 ops
      ├── ops ≤ threshold  → PatchMessage  { _type: "patch", _baseV, _v, _patch }
      ├── ops > threshold  → FullStateMessage { _type: "full", _v, ...state }
      └── push to all SSE subscribers
      │
      ▼
  Client: applyBroadcastMessage(msg, cached)
      │
      ├── full   → accept if _v ≥ cachedV
      ├── patch  → apply if _baseV === cachedV
      ├── stale  → skip (client ahead, mutation response arrived first)
      └── behind → invalidate + refetch (client missed a version)
```

## Server Usage

```typescript
import { BroadcastChannel, PresenceTracker } from "@rotorsoft/act-sse";

// Create a typed broadcast channel for your app state
const broadcast = new BroadcastChannel<MyAppState>({
  maxPatchOps: 50,   // fall back to full state above this (default: 50)
  cacheSize: 50,     // LRU cache entries (default: 50)
});

const presence = new PresenceTracker();

// After every app.do():
const snap = await doAction(action, { stream: streamId, actor }, payload);
const state = deriveState(snap);           // your app-specific state derivation
state._v = snap.event.version;             // MUST set from event store version
broadcast.publish(streamId, state);

// For non-event state changes (e.g. presence overlay):
broadcast.publishOverlay(streamId, stateWithPresence);

// SSE subscription (tRPC example):
onStateChange: publicProcedure
  .input(z.object({ streamId: z.string(), identityId: z.string().optional() }))
  .subscription(async function* ({ input, signal }) {
    const { streamId, identityId } = input;

    let resolve: (() => void) | null = null;
    let pending: BroadcastMessage | null = null;

    const cleanup = broadcast.subscribe(streamId, (msg) => {
      pending = msg;
      if (resolve) { resolve(); resolve = null; }
    });

    if (identityId) presence.add(streamId, identityId);

    try {
      // Yield current state on connect
      const cached = broadcast.getState(streamId);
      if (cached) yield { _type: "full" as const, ...cached, serverTime: new Date().toISOString() };

      while (!signal?.aborted) {
        if (!pending) {
          await new Promise<void>((r) => {
            resolve = r;
            signal?.addEventListener("abort", () => r(), { once: true });
          });
        }
        if (signal?.aborted) break;
        if (pending) {
          const msg = pending;
          pending = null;
          yield msg;
        }
      }
    } finally {
      cleanup();
      if (identityId) presence.remove(streamId, identityId);
    }
  }),
```

## Client Usage

```typescript
import { applyBroadcastMessage } from "@rotorsoft/act-sse";

// In your SSE onData handler (React Query example):
onData: (msg) => {
  const cached = utils.getState.getData({ streamId });
  const result = applyBroadcastMessage(msg, cached);

  if (result.ok) {
    utils.getState.setData({ streamId }, result.state);
  } else if (result.reason === "behind") {
    // Client missed a version — trigger full refetch
    utils.getState.invalidate({ streamId });
  }
  // "stale" → no-op (client already has newer state from mutation response)
  // "patch-failed" → same as behind, trigger resync
}
```

## API

### `BroadcastChannel<S>`

Server-side broadcast manager with per-stream subscriber channels and LRU state cache.

| Method | Description |
|--------|-------------|
| `publish(streamId, state)` | Compute patch, cache state, push to subscribers |
| `publishOverlay(streamId, state)` | Same-version update (e.g. presence change) |
| `subscribe(streamId, cb)` | Register subscriber, returns cleanup function |
| `getState(streamId)` | Get cached state (for reconnects) |
| `getSubscriberCount(streamId)` | Number of active subscribers |
| `cache` | Direct access to `StateCache` instance |

### `applyBroadcastMessage(msg, cached)`

Client-side patch applicator. Returns `{ ok: true, state }` or `{ ok: false, reason }`.

Reasons: `"stale"` (skip), `"behind"` (resync), `"patch-failed"` (resync).

### `StateCache<S>`

Generic LRU cache. Methods: `get`, `set`, `delete`, `has`, `size`, `entries`.

### `PresenceTracker`

Ref-counted presence tracking. Methods: `add`, `remove`, `getOnline`, `isOnline`.

### Message Types

```typescript
type FullStateMessage<S> = S & { _type: "full"; serverTime: string };
type PatchMessage = { _type: "patch"; _v: number; _baseV: number; _patch: Operation[]; serverTime: string };
type BroadcastMessage<S> = FullStateMessage<S> | PatchMessage;
```

## Version Contract

The `_v` field **must** be set from `snap.event.version` — the event store's monotonic stream version. This is the single source of truth for ordering. No separate version counters.

## Bandwidth Savings

Typical savings for a game/collaborative app with ~5KB state:

| Action | Full (bytes) | Patch (bytes) | Savings |
|--------|-------------|--------------|---------|
| Single field change | ~5,000 | ~150 | 97% |
| Multi-field update | ~5,000 | ~400 | 92% |
| Presence toggle | ~5,000 | ~80 | 98% |
| Large structural change | ~5,000 | ~5,000 (fallback) | 0% |

## License

MIT
