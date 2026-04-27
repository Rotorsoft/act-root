# @rotorsoft/act-sse

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-sse.svg)](https://www.npmjs.com/package/@rotorsoft/act-sse)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-sse.svg)](https://www.npmjs.com/package/@rotorsoft/act-sse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Incremental state broadcast over SSE for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) event-sourced apps. Zero dependencies.

Instead of sending full aggregate state after each action, `act-sse` forwards the domain patches that event handlers already compute — sending only what changed as version-keyed partials.

## Installation

```sh
npm install @rotorsoft/act-sse
# or
pnpm add @rotorsoft/act-sse
```

**Requirements:** Node.js >= 22.18.0

## Architecture

```
  app.do() → Snapshot[] (each carries its event's domain patch)
      │
      ▼
  deriveState(snap)              ← app-specific (overlay presence, deadlines, etc.)
  state._v = snap.event.version  ← event store version is the single source of truth
      │
      ▼
  broadcast.publish(streamId, state, patches)
      │
      └── version-key each patch → { "5": { count: 3 }, "6": { name: "updated" } }
      └── push to all SSE subscribers
      │
      ▼
  Client: applyPatchMessage(msg, cached)
      │
      ├── contiguous → deep merge patches in version order
      ├── stale      → skip (client already ahead)
      └── behind     → invalidate + refetch (client missed versions)
```

## Wire Format

```typescript
// Version-keyed domain patches
// Keys = state version after that patch is applied
// Values = domain patch (deep partial of state)
{
  "5": { territories: { brazil: { armies: 3 } } },
  "6": { currentPlayerIndex: 2, phase: "reinforce" }
}
```

Multi-event commits produce multiple version-keyed entries. Version gaps trigger full state refetch on the client.

## Server Usage

```typescript
import { BroadcastChannel } from "@rotorsoft/act-sse";

const broadcast = new BroadcastChannel<MyAppState>();

// After every app.do():
const snaps = await app.do(action, target, payload);
const snap = snaps.at(-1)!;
const patches = snaps.map(s => s.patch).filter(Boolean);
const state = deriveState(snap);
broadcast.publish(streamId, state, patches);

// For non-event state changes (e.g. presence overlay):
broadcast.publishOverlay(streamId, { players: { pid: { connected: true } } });

// SSE subscription (tRPC example):
onStateChange: publicProcedure
  .input(z.object({ streamId: z.string() }))
  .subscription(async function* ({ input, signal }) {
    let resolve: (() => void) | null = null;
    let pending: PatchMessage | null = null;

    const cleanup = broadcast.subscribe(input.streamId, (msg) => {
      pending = msg;
      if (resolve) { resolve(); resolve = null; }
    });

    try {
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
    }
  }),
```

## Client Usage

```typescript
import { applyPatchMessage } from "@rotorsoft/act-sse";

// In your SSE onData handler (React Query example):
onData: (msg) => {
  const cached = utils.getState.getData({ streamId });
  const result = applyPatchMessage(msg, cached);

  if (result.ok) {
    utils.getState.setData({ streamId }, result.state);
  } else if (result.reason === "behind") {
    // Client missed versions — trigger full refetch
    utils.getState.invalidate({ streamId });
  }
  // "stale" → no-op (client already has newer state from mutation response)
}
```

## API

### `BroadcastChannel<S>`

Server-side broadcast manager with per-stream subscriber channels and LRU state cache.

| Method | Description |
|--------|-------------|
| `publish(streamId, state, patches?)` | Cache state, version-key patches, push to subscribers |
| `publishOverlay(streamId, patch)` | Same-version update (e.g. presence change) |
| `subscribe(streamId, cb)` | Register subscriber, returns cleanup function |
| `getState(streamId)` | Get cached state (for reconnects) |
| `getSubscriberCount(streamId)` | Number of active subscribers |
| `cache` | Direct access to `StateCache` instance |

### `applyPatchMessage(msg, cached)`

Client-side patch applicator. Returns `{ ok: true, state }` or `{ ok: false, reason }`.

Reasons: `"stale"` (skip), `"behind"` (resync).

### `patch(original, patches)`

Browser-safe deep merge utility. Deep merges plain objects, replaces arrays and other non-mergeable types (Date, Map, Set, RegExp, TypedArrays). Deletes keys set to `null` or `undefined`.

### `StateCache<S>`

Generic LRU cache. Methods: `get`, `set`, `delete`, `has`, `size`, `entries`.

### Types

```typescript
type BroadcastState = Record<string, unknown> & { _v: number };
type PatchMessage<S extends BroadcastState> = Record<number, DeepPartial<S>>;
type Subscriber<S extends BroadcastState> = (msg: PatchMessage<S>) => void;
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

## Related

- [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) - Core framework
- [@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg) - PostgreSQL adapter
- [Documentation](https://rotorsoft.github.io/act-root/)
- [Examples](https://github.com/rotorsoft/act-root/tree/master/packages)

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
