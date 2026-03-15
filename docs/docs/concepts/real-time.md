---
id: real-time
title: Real-Time with SSE
---

# Real-Time with act-sse

`@rotorsoft/act-sse` provides incremental state broadcast over Server-Sent Events. Instead of sending the full state on every change, it computes RFC 6902 JSON Patches and sends only the diff.

```
npm install @rotorsoft/act-sse
```

## Architecture

```
app.do() → snap
    │
    ▼
deriveState(snap)              ← app-specific (overlay presence, etc.)
state._v = snap.event.version  ← event store version = single source of truth
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
    ├── stale  → skip (client already ahead)
    └── behind → invalidate + refetch (client missed a version)
```

## Server-Side Setup

### BroadcastChannel

Manages per-stream subscriber sets and an LRU state cache:

```typescript
import { BroadcastChannel, PresenceTracker } from "@rotorsoft/act-sse";
import type { BroadcastState } from "@rotorsoft/act-sse";

type AppState = BroadcastState & {
  // your domain state fields
  name: string;
  status: string;
};

const broadcast = new BroadcastChannel<AppState>({
  maxPatchOps: 50,   // fall back to full state above this
  cacheSize: 50,     // LRU cache entries
});
```

### PresenceTracker

Ref-counted online status per stream per identity, supporting multi-tab scenarios:

```typescript
const presence = new PresenceTracker();

// On client connect
presence.add(streamId, identityId);

// On client disconnect
presence.remove(streamId, identityId);

// Check who's online
const online = presence.getOnline(streamId); // Set<string>
```

### Broadcasting State

Create a single broadcast function used by all code paths that call `app.do()`:

```typescript
function broadcastState(streamId: string, snap: Snap) {
  const state: AppState = {
    ...snap.state,
    _v: snap.event!.version,  // MUST use event store version
  };
  const withPresence = applyPresence(state, streamId);
  broadcast.publish(streamId, withPresence);
}

// After every mutation
const snaps = await app.do("CreateItem", target, input);
const snap = snaps[snaps.length - 1];
broadcastState(streamId, snap);
app.settle();
```

### SSE Subscription (tRPC)

```typescript
onStateChange: publicProcedure
  .input(z.object({ streamId: z.string(), identityId: z.string().optional() }))
  .subscription(async function* ({ input, signal }) {
    const { streamId, identityId } = input;
    let resolve: (() => void) | null = null;
    let pending: BroadcastMessage<AppState> | null = null;

    const cleanup = broadcast.subscribe(streamId, (msg) => {
      pending = msg;
      if (resolve) { resolve(); resolve = null; }
    });

    if (identityId) {
      presence.add(streamId, identityId);
      broadcastPresenceChange(streamId);
    }

    try {
      // Yield current state on connect
      const cached = broadcast.getState(streamId);
      if (cached) yield { _type: "full" as const, ...cached };

      while (!signal?.aborted) {
        if (!pending) {
          await new Promise<void>((r) => {
            resolve = r;
            signal?.addEventListener("abort", () => r(), { once: true });
          });
        }
        if (signal?.aborted) break;
        if (pending) { const msg = pending; pending = null; yield msg; }
      }
    } finally {
      cleanup();
      if (identityId) {
        presence.remove(streamId, identityId);
        broadcastPresenceChange(streamId);
      }
    }
  }),
```

## Client-Side Patch Application

```typescript
import { applyBroadcastMessage } from "@rotorsoft/act-sse";

// In SSE onData handler (React Query)
onData: (msg) => {
  const cached = utils.getState.getData({ streamId });
  const result = applyBroadcastMessage(msg, cached);

  if (result.ok) {
    utils.getState.setData({ streamId }, result.state);
  } else if (result.reason === "behind" || result.reason === "patch-failed") {
    utils.getState.invalidate({ streamId }); // trigger full refetch
  }
  // "stale" → no-op (client already has newer state)
}
```

### Version Logic

- **Stale** — all patches older than cached version → no-op (client ahead, mutation response arrived first)
- **Behind** — gap between cached version and first patch → trigger full refetch
- **Contiguous** — apply patches in order, updating `_v` to final patch version

## Key Rules

1. **`_v` is always `snap.event.version`** — the event store's monotonic stream version is the single source of truth
2. **Single broadcast function** — all `app.do()` paths funnel through one function
3. **Snapshots for hot path, projections for reads** — never broadcast from projection state (risk of double-apply)
4. **Presence is an overlay** — use `publishOverlay()` for non-event state changes (connect/disconnect)

## The Double-Apply Bug

If a projection falls back to the broadcast cache on a miss, it reads state that already has event patches applied. The projection then re-applies those same patches, corrupting counters and indices.

```typescript
// BUG — broadcast cache holds post-event snapshots
let state = projCache.get(id) ?? broadcast.getState(id); // ← already patched!
mutator(state); // patches applied twice

// FIX — fall back to DB only
let state = projCache.get(id) ?? await db.select(id) ?? defaultState();
mutator(state);
```
