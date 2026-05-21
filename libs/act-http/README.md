# @rotorsoft/act-http

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-http.svg)](https://www.npmjs.com/package/@rotorsoft/act-http)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-http.svg)](https://www.npmjs.com/package/@rotorsoft/act-http)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_HTTP integrations for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) — outbound webhooks and incremental state broadcast over Server-Sent Events._

> **Note.** This package consolidates the SSE integration that previously shipped as standalone `@rotorsoft/act-sse`. New projects should install this umbrella and import from the `/sse` subpath; existing `@rotorsoft/act-sse` users can migrate with a one-import change. See [@rotorsoft/act-sse](https://www.npmjs.com/package/@rotorsoft/act-sse) for the deprecation note + migration steps.

## Why this package

Most Act apps reach beyond their own process eventually — POSTing committed events to a downstream service, broadcasting state to a live UI, or both. The patterns are different (outbound HTTP vs long-lived `text/event-stream`), but they share a transport (HTTP) and an integration mental model ("Act over the wire"). Combining them under one umbrella with subpath exports gives you one install + one mental model, without conflating two implementations.

`webhook()` is sugar on top of `.do(handler, { backoff })` — the same `fetch` wrapper most teams end up writing (timeout, idempotency key, status-classified errors, JSON serialization). The SSE surface is the verbatim continuation of `@rotorsoft/act-sse`. Nothing in `webhook` depends on `sse` or vice versa — pay only for what you import.

## Installation

```bash
pnpm add @rotorsoft/act-http
```

Two independent subpath exports:

| Import path | What you get |
|---|---|
| `@rotorsoft/act-http/webhook` | `webhook()` — reaction handler that POSTs committed events with timeout, auto `Idempotency-Key`, and status-classified errors. |
| `@rotorsoft/act-http/sse` | `BroadcastChannel`, `PresenceTracker`, `StateCache`, `applyPatchMessage` — server-side broadcast + client-side patch applicator for incremental state sync. |

## Quick start

### `webhook` — outbound POST from a reaction

```ts
import { webhook } from "@rotorsoft/act-http/webhook";

.on("OrderConfirmed")
  .do(
    webhook({
      url: "https://api.example.com/webhooks/orders",
      headers: (event) => ({ Authorization: "Bearer " + token }),
      body: (event) => ({ orderId: event.stream, total: event.data.total }),
      timeoutMs: 2_000,
    }),
    {
      maxRetries: 5,
      backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000, jitter: true },
    }
  )
  .to(resolver)
```

### `sse` — live state broadcast

```ts
import { BroadcastChannel, applyPatchMessage } from "@rotorsoft/act-http/sse";

// Server: after every app.do()
const snaps = await app.do(action, target, payload);
const patches = snaps.map((s) => s.patch).filter(Boolean);
const state = deriveState(snaps.at(-1)!);
broadcast.publish(streamId, state, patches);

// Client: in your SSE onData handler
onData: (msg) => {
  const cached = utils.getState.getData({ streamId });
  const result = applyPatchMessage(msg, cached);
  if (result.ok) utils.getState.setData({ streamId }, result.state);
  else if (result.reason === "behind") utils.getState.invalidate({ streamId });
};
```

## API

### `/webhook` subpath

- **`webhook(config)`** — reaction-handler factory. Returns a function compatible with `.do(handler, opts)`.
- **`WebhookError`** — thrown on 5xx, network errors, and timeouts. Carries `status` (`0` for network/timeout) and `url`. Retryable by drain.
- **`NonRetryableWebhookError`** — thrown on 4xx. Extends `NonRetryableError` from `@rotorsoft/act`; the drain finalizer blocks the stream on first attempt without consuming the retry budget.
- **`WebhookConfig`** — TypeScript type for the helper options.

### `/sse` subpath

- **`BroadcastChannel<S>`** — server-side broadcast manager with per-stream subscriber sets and an LRU state cache.
- **`PresenceTracker`** — ref-counted online-status tracker for multi-tab clients.
- **`StateCache<S>`** — the generic LRU used internally by `BroadcastChannel`.
- **`applyPatchMessage(msg, cached)`** — client-side patch applicator. Returns `{ ok: true, state }` or `{ ok: false, reason: "stale" | "behind" }`.
- **`patch(original, patches)`** — browser-safe deep-merge utility (re-exported from `@rotorsoft/act-patch`).
- **Types**: `BroadcastState`, `PatchMessage<S>`, `Subscriber<S>`.

## Configuration

### `webhook` options

| Option | Type | Default |
|---|---|---|
| `url` | `string` or `(event) => string` | required |
| `method` | `"POST" | "PUT" | "PATCH" | "DELETE"` | `"POST"` |
| `headers` | `Record<string, string>` or `(event) => …` | `{}` |
| `body` | `unknown` or `(event) => unknown` | the committed event (JSON-serialized) |
| `timeoutMs` | `number` | `5000` |
| `idempotencyKey` | `(event) => string | null` | `String(event.id)` |
| `fetch` | `typeof fetch` | `globalThis.fetch` |

Strings as `body` are sent as-is; anything else is `JSON.stringify`'d and `Content-Type: application/json` is set automatically (unless the caller supplies it).

A caller-supplied `Idempotency-Key` header (case-insensitive) always wins; the auto-derived `event.id` is only applied when the header is absent. `event.id` is the framework's immutable, per-event monotonic integer — well-suited to downstream dedup.

## Common patterns

### Retry & block semantics

The drain pipeline retries on `WebhookError` per `maxRetries` and paces with `backoff`. It blocks immediately on `NonRetryableWebhookError` (when `blockOnError` is true) — no retry budget consumed.

| Shape | Config |
|---|---|
| **Be patient with the receiver** (the 80% default) | `{ maxRetries: 5, backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000, jitter: true } }` |
| **Never give up** | `{ maxRetries: Infinity, blockOnError: false, backoff: {…} }` — for sinks that *must* eventually succeed. 4xx falls back to the same loop. |
| **Strict — block on any failure** | `{ maxRetries: 0 }` — useful for endpoints with strong idempotency where any failed POST warrants operator review. |

In catch blocks, distinguish retryable from non-retryable via the two classes (or the shared `status` field):

```ts
try {
  await deliver();
} catch (err) {
  if (err instanceof NonRetryableWebhookError) {
    // 4xx — caller bug or permanent state; log and move on
  } else if (err instanceof WebhookError) {
    // retryable — drain will handle
  }
}
```

Generic catch sites that don't care about HTTP specifics can match on the base `NonRetryableError` from `@rotorsoft/act`.

### Recovering a blocked stream

When `webhook` blocks a stream — whether on first attempt (4xx) or after exhausting retries — the operator's recovery path is `app.unblock(input)` from `@rotorsoft/act`. It clears the blocked flag and resumes from where the stream stopped, *not* from the beginning. Don't use `app.reset()` — `reset` rebuilds from event 0 and would re-fire every historical webhook.

```ts
await app.unblock(["webhooks-out-customer-42"]);     // by name
await app.unblock({ stream: "^webhooks-out-" });     // bulk by pattern
```

Use `app.blocked_streams()` to discover what's currently blocked.

### SSE wire format

Version-keyed domain patches; keys are the state version *after* the patch applies:

```ts
{
  "5": { territories: { brazil: { armies: 3 } } },
  "6": { currentPlayerIndex: 2, phase: "reinforce" }
}
```

Multi-event commits produce multiple entries in one message. Version gaps trigger full state refetch on the client (`applyPatchMessage` returns `{ ok: false, reason: "behind" }`).

## When `webhook` is the right tool — and when it isn't

`webhook` is built for **fire-and-forget delivery to a cooperative receiver**: timeouts shorter than the drain lease, retries paced by `backoff`, idempotent endpoints.

**Keep `timeoutMs` below `leaseMillis`.** The drain lease stops competing workers from re-dispatching while your handler is in flight. The default lease is a few seconds; the default `timeoutMs` is `5000`. If `timeoutMs` approaches or exceeds the lease, a slow receiver can hold the lease through expiry, another worker claims the stream, and the same event POSTs twice. The downstream `Idempotency-Key` then becomes load-bearing — if your receiver doesn't dedup, you'll deliver twice. Rule: `timeoutMs ≤ leaseMillis - safety_margin`.

**For heavy or long-running delivery, don't use `webhook` directly.** Drain leases aren't free, and holding one for tens of seconds while a slow API churns is the wrong shape. The Act-native pattern is **outbox-style fan-out**: emit a "needs delivery" event from your reaction (a cheap, local operation), and let a separate consumer — a downstream worker, a Kafka/SQS pipeline, an external scheduler — do the long work at its own pace.

| Shape of work | Right tool |
|---|---|
| 1–2s POST to a fast, idempotent API | `webhook` directly |
| Webhook to a flaky-but-fast third party | `webhook` + aggressive `backoff` |
| Multi-second / multi-minute API call | Emit a "needs delivery" event; bus worker calls the API |
| Bulk fan-out (10k+ receivers) | Emit a "fanout" event; dedicated consumer enumerates receivers |
| Streaming / long-poll / large file transfer | Not `webhook` — write a dedicated worker |

For the recommended receiver-side idempotency contract that pairs with `webhook`, see the [external integration guide](https://rotorsoft.github.io/act-root/docs/guides/external-integration).

## Compatibility

- **Node**: >=22.18.0
- **Peer**: `@rotorsoft/act` (workspace version)
- **Runtime deps**: `@rotorsoft/act-patch` (used by the SSE subpath for state merging)
- **Module formats**: ESM + CJS, dual subpath exports
- **Browser**: the `/sse` client-side helpers (`applyPatchMessage`, `patch`, types) are browser-safe and have no Node-specific dependencies

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). Both subpaths (`@rotorsoft/act-http/webhook` and `@rotorsoft/act-http/sse`) are covered by the charter. The `sse` subpath hosts the surface formerly published as `@rotorsoft/act-sse`, now deprecated. Charter is **in effect as of 1.0.0**; the milestone tracker is [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — core framework. `webhook` composes with `.do(handler, { backoff })`; `BroadcastChannel` publishes from `app.do()` snapshots.
- **[@rotorsoft/act-sse](https://www.npmjs.com/package/@rotorsoft/act-sse)** — predecessor of the `/sse` subpath here. Being deprecated; migrate to `@rotorsoft/act-http/sse`.
- **[@rotorsoft/act-patch](https://www.npmjs.com/package/@rotorsoft/act-patch)** — the immutable patch utility that powers the SSE state merge.
- **[@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg)** / **[@rotorsoft/act-sqlite](https://www.npmjs.com/package/@rotorsoft/act-sqlite)** — store adapters. `webhook` reactions persist their watermarks through whichever store you've wired.

## Documentation

- **[External integration patterns](https://rotorsoft.github.io/act-root/docs/guides/external-integration)** — inline `webhook` vs forwarded bus, receiver-side idempotency contract, the recovery loop.
- **[Real-time with SSE](https://rotorsoft.github.io/act-root/docs/concepts/real-time)** — concept guide for the `/sse` surface.
- **[Error handling](https://rotorsoft.github.io/act-root/docs/concepts/error-handling)** — backoff, `NonRetryableError`, blocked streams, `unblock` recovery.

## License

MIT
