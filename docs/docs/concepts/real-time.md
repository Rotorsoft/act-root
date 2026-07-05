---
id: real-time
title: Real-Time with SSE
---

# Real-Time with act-http/sse

`@rotorsoft/act-http/sse` broadcasts incremental state updates over Server-Sent Events. Each event-sourced commit emits a *domain patch* (a partial state update); the broadcast layer forwards those patches keyed by event version, so subscribers can apply them to their cached state without ever refetching.

> SSE is one of two HTTP-shaped integration paths. For the outbound side — webhooks, downstream services, message buses — see [External integration patterns](../guides/external-integration). The two are independent; an app can run both.

```bash
npm install @rotorsoft/act-http
```

> **Migrating from `@rotorsoft/act-sse`?** The standalone package is deprecated — it's now a thin re-export shim over `@rotorsoft/act-http/sse` (the canonical home) and is scheduled for removal. The surface is identical; swap the import specifier and you're done. See the [1.x migration guide](../guides/migrating-to-1.x).

## See it running

The multi-transport calculator demo wires SSE end-to-end next to tRPC, Hono REST, and OpenAPI:

- `packages/server/src/server.ts` — publishes every commit to a `BroadcastChannel` from a single `committed` lifecycle listener and mounts the generated `GET /api/sse/Calculator?stream=<id>` endpoint via `hono(app, { sse })`.
- `packages/client/src/useSse.ts` — a small `EventSource` hook that applies `event: patch` frames with `applyPatchMessage` and reconnects on `behind` to re-seed from the server's cached `event: state` frame.
- `packages/client/src/Calculator.tsx` — renders the SSE-fed state live under the keypad.

Run `pnpm dev:http` from the repo root and press keys at [http://localhost:3000](http://localhost:3000) — the live panel updates on every commit without refetching, from either transport or another browser tab.

## Architecture

```
   app.do() → snapshots (each carries its domain patch)
       │
       ▼
   deriveState(snap)              ← app-specific (overlay presence, etc.)
   state._v = snap.event.version  ← event store version = single source of truth
       │
       ▼
   broadcast.publish(streamId, state, patches)
       │
       ├── version-key each patch: { [baseV+1]: patch1, [baseV+2]: patch2, ... }
       └── push to all SSE subscribers
       │
       ▼
   Client: applyPatchMessage(msg, cached)
       │
       ├── contiguous → deep-merge patches in version order
       ├── stale      → skip (client already ahead)
       └── behind     → resync (client missed versions)
```

## The version contract

`_v` on every state object is always `snap.event.version` — the event store's monotonic stream version. There is no separate counter, no clock-based ordering. The event store is the single source of truth for ordering; the broadcast layer is just a fan-out.

## Server-side

### BroadcastChannel

Manages per-stream subscriber sets and an LRU state cache for reconnects:

```typescript no-check
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import type { BroadcastState, PatchMessage } from "@rotorsoft/act-http/sse";

type AppState = BroadcastState & {
  // your domain state fields
  name: string;
  status: string;
};

const broadcast = new BroadcastChannel<AppState>({
  cacheSize: 50, // LRU entries; default 50
});
```

:::note
The snake_case member names these classes originally shipped with (`publish_overlay`, `get_state`, `get_subscriber_count`, `cache_size`, `get_online`, `is_online`) still work but are deprecated aliases — scheduled for removal in the next major. Use the short names shown here (`overlay`, `state`, `subscriberCount`, `cacheSize`, `online`, `isOnline`).
:::

### Broadcasting a commit

After every `app.do()`, forward each emitted snapshot's domain patch:

```typescript no-check
const snaps = await app.do("CreateItem", target, input);
const last = snaps.at(-1)!;

// 1. Derive the broadcast view (typically snap.state plus overlays)
const state: AppState = {
  ...last.state,
  _v: last.event!.version, // MUST come from event.version
};

// 2. Collect each emitted snapshot's patch, in commit order
const patches = snaps
  .map((s) => s.patch)
  .filter(Boolean) as Partial<AppState>[];

// 3. Publish — sends a version-keyed PatchMessage to all subscribers
broadcast.publish(streamId, state, patches);
// Reactions drain automatically if you've wired
// app.on("committed", () => app.settle()) at bootstrap.
```

`publish()` writes the new state to the LRU cache (so reconnects can read it) and pushes a `PatchMessage<AppState>` to subscribers. The keys of the message are absolute event versions (`baseV + 1`, `baseV + 2`, …), so subscribers can apply them directly to their cached state without computing offsets.

### Overlays (non-event state changes)

Some state changes don't have a corresponding event — typically presence ("alice is online") or computed-field refreshes. Use `overlay()`:

```typescript no-check
broadcast.overlay(streamId, {
  onlineUsers: presence.online(streamId),
});
```

This applies the overlay to the cached state, leaves `_v` unchanged, and emits a single-key patch message at the cached version.

### Presence

`PresenceTracker` is a ref-counted online-status tracker designed for multi-tab clients (each tab opens its own SSE; `add` / `remove` maintain a per-identity counter):

```typescript no-check
import { PresenceTracker } from "@rotorsoft/act-http/sse";

const presence = new PresenceTracker();

// On SSE connect
presence.add(streamId, identityId);

// On SSE disconnect
presence.remove(streamId, identityId);

// Query
presence.online(streamId); // Set<string>
presence.isOnline(streamId, identityId); // boolean
```

### If you use the generated transports

You may not need to write a subscription handler at all. Both `trpc(app, { sse })` and `hono(app, { sse })` from `@rotorsoft/act-http` accept an `sse: { channel: broadcast }` option that walks the registry and emits one subscription — or one streaming `GET /api/sse/<stateName>?stream=<id>` endpoint — per registered state, all reading from your `BroadcastChannel`. You keep owning publication (`broadcast.publish(...)` after commits); the generator owns subscription, accounting, cleanup, and the wire format. See [Auto-generated API surfaces § Real-time subscriptions](../guides/auto-generated-api#real-time-subscriptions), and the runnable demo in `packages/server` + `packages/client` (`pnpm dev:http` from the repo root).

The section below is the custom-server path — the same loop the generator writes for you, hand-rolled for hosts the generators don't cover.

### tRPC subscription (custom server)

`act-http/sse` doesn't dictate the wire format — your tRPC handler decides. A typical pattern yields the cached state on connect, then forwards each patch message. Wrap the two shapes in a small app-level envelope so the client can tell them apart:

```typescript no-check
import type { PatchMessage } from "@rotorsoft/act-http/sse";

type Envelope<S> =
  | { kind: "snap"; state: S }
  | { kind: "patch"; msg: PatchMessage<S> };

export const onStateChange = publicProcedure
  .input(z.object({ streamId: z.string(), identityId: z.string().optional() }))
  .subscription(async function* ({ input, signal }) {
    const { streamId, identityId } = input;
    let resolve: (() => void) | null = null;
    let pending: PatchMessage<AppState> | null = null;

    const cleanup = broadcast.subscribe(streamId, (msg) => {
      pending = msg;
      resolve?.();
      resolve = null;
    });

    if (identityId) presence.add(streamId, identityId);

    try {
      // Initial snapshot for first paint
      const cached = broadcast.state(streamId);
      if (cached) yield { kind: "snap", state: cached } satisfies Envelope<AppState>;

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
          yield { kind: "patch", msg } satisfies Envelope<AppState>;
        }
      }
    } finally {
      cleanup();
      if (identityId) presence.remove(streamId, identityId);
    }
  });
```

## Client-side

### applyPatchMessage

```typescript no-check
import { applyPatchMessage } from "@rotorsoft/act-http/sse";

onData: (env) => {
  if (env.kind === "snap") {
    utils.getState.setData({ streamId }, env.state);
    return;
  }
  const cached = utils.getState.getData({ streamId });
  const result = applyPatchMessage(env.msg, cached);

  if (result.ok) {
    utils.getState.setData({ streamId }, result.state);
  } else if (result.reason === "behind") {
    utils.getState.invalidate({ streamId }); // missed versions — refetch
  }
  // "stale" → no-op; the cache is already past these versions
};
```

`applyPatchMessage(msg, cached)` returns `{ ok: true, state } | { ok: false, reason: "stale" | "behind" }`:

- **Contiguous** — `min(msg.keys)` is exactly `cachedV + 1`. Apply patches in version order via the deep-merge from `@rotorsoft/act-patch`; final `_v` = `max(msg.keys)`.
- **Stale** — `max(msg.keys) <= cachedV`. The client is already ahead (e.g., a mutation response landed before the SSE patch arrived). No-op.
- **Behind** — `min(msg.keys) > cachedV + 1`. The client missed versions and must resync via a full refetch.

## Key rules

1. **`_v` is `snap.event.version`** — the event store's stream version is the single source of truth. Never invent a version.
2. **One broadcast function** — every code path that calls `app.do()` should funnel through the same publish helper. Multiple publish sites with different state shapes is how double-apply bugs start.
3. **Broadcast from snapshots, not projections** — projections are eventually consistent and may lag. Broadcast from the snapshots returned by `app.do()`.
4. **Presence is an overlay, not an event** — use `overlay()` so connect/disconnect doesn't pollute the event log.

## The double-apply bug

If a projection falls back to the broadcast cache on a miss, it reads state that already has event patches applied. Re-applying those same patches corrupts counters and indices.

```typescript no-check
// BUG — broadcast cache holds post-event snapshots
let state = projCache.get(id) ?? broadcast.state(id); // ← already patched!
mutator(state); // patches applied a second time

// FIX — fall back to durable storage only
let state = projCache.get(id) ?? (await db.select(id)) ?? defaultState();
mutator(state);
```

The broadcast cache exists for *reconnect seeding* and for `overlay()`'s read-modify-write. Everything else should go through the database.
