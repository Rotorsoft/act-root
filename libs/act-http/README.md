# @rotorsoft/act-http

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-http.svg)](https://www.npmjs.com/package/@rotorsoft/act-http)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-http.svg)](https://www.npmjs.com/package/@rotorsoft/act-http)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

HTTP integrations for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) event-sourced apps.

> **Stability:** Public API governed by the [Act Stability Charter](../../STABILITY.md). Charter takes effect at 1.0 (gated on [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1)).

## Installation

```sh
pnpm add @rotorsoft/act-http
```

Two subpath exports, picked at import time so you only pay for what you use:

| Import path | What you get |
|---|---|
| `@rotorsoft/act-http/webhook` | `webhook()` — reaction handler that POSTs committed events to an external URL with timeout, auto idempotency key, and status-classified errors. |
| `@rotorsoft/act-http/sse` | `BroadcastChannel`, `PresenceTracker`, `StateCache`, `applyPatchMessage` — server-side broadcast + client-side patch applicator for incremental state sync over Server-Sent Events. |

The two are independent; nothing in `webhook` depends on `sse` or vice versa.

---

## `webhook` — outbound HTTP from reactions

Sugar on top of `.do(handler, { backoff })` from ACT-601. Drops the same `fetch` wrapper most teams end up writing: timeout, `Idempotency-Key`, JSON serialization, and status-coded errors.

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

### Behavior

| Outcome | Thrown | Drain behavior |
|---|---|---|
| 2xx response | (resolves) | — |
| 5xx response | `WebhookError` | retries per `maxRetries` + `backoff` |
| Network error | `WebhookError` (`status: 0`) | retries per `maxRetries` + `backoff` |
| Timeout | `WebhookError` (`status: 0`, abort) | retries per `maxRetries` + `backoff` |
| 4xx response | `NonRetryableWebhookError` | **blocks on first attempt** (when `blockOnError` is true) |

The two-class split is the retry signal — `NonRetryableWebhookError` extends [`NonRetryableError`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/errors.ts) (from `@rotorsoft/act`), which the drain finalizer recognizes and treats as "block immediately, no more retries." Permanent client errors don't burn the retry budget or pace through the backoff window.

A `NonRetryableWebhookError` does not override `blockOnError: false`. If the operator explicitly chose "retry forever," the framework respects that.

### Idempotency key

The helper sets `Idempotency-Key: <event.id>` by default. `event.id` is the framework's immutable, per-event monotonic integer — perfect for downstream dedup. Override with a function that returns a string (or `null` to skip the header):

```ts
webhook({
  url: "...",
  idempotencyKey: (event) => `${event.stream}-${event.id}`,
})
```

A caller-supplied `Idempotency-Key` header (case-insensitive) always wins; the auto-derived value is only applied when the header is absent.

### Configuration

| Option | Type | Default |
|---|---|---|
| `url` | `string \| (event) => string` | required |
| `method` | `"POST" \| "PUT" \| "PATCH" \| "DELETE"` | `"POST"` |
| `headers` | `Record<string, string> \| (event) => Record<string, string>` | `{}` |
| `body` | `unknown \| (event) => unknown` | the committed event (JSON-serialized) |
| `timeoutMs` | `number` | `5000` |
| `idempotencyKey` | `(event) => string \| null` | `String(event.id)` |
| `fetch` | `typeof fetch` | `globalThis.fetch` |

Strings as `body` are sent as-is. Anything else is `JSON.stringify`'d, and `Content-Type: application/json` is set automatically (unless the caller supplies their own).

---

### When `webhook` is the right tool — and when it isn't

`webhook` is built for **fire-and-forget delivery to a cooperative receiver**: timeouts shorter than the drain lease, retries paced by `backoff`, and idempotent endpoints that can absorb the occasional duplicate.

> **Keep `timeoutMs` below `leaseMillis`.** The drain lease is what stops competing workers from re-dispatching while your handler is still in flight. The default lease is a few seconds; the default `timeoutMs` is `5000`. If you set `timeoutMs` to something approaching or exceeding the lease, a slow receiver can hold the lease through expiry, at which point another worker will claim the stream and dispatch the same event in parallel. The downstream `Idempotency-Key` then becomes load-bearing — if your receiver doesn't deduplicate, you'll deliver twice.
>
> Concretely: keep `timeoutMs ≤ leaseMillis - safety_margin`. If you need a longer window, bump `leaseMillis` globally on the Act options.

**For heavy or long-running delivery, don't use `webhook`.** Drain leases aren't free, and holding one for tens of seconds while a slow API churns is the wrong shape. The Act-native pattern is an **outbox-style fan-out**: emit a "needs delivery" event from your reaction (a cheap, local operation), and let a separate consumer — a downstream worker, a Kafka/SQS pipeline, an external scheduler — pick it up and do the long work. Drain stays responsive; the slow path runs at its own pace.

| Shape of work | Right tool |
|---|---|
| 1–2s POST to a fast, idempotent API | `webhook` directly |
| Webhook to a flaky-but-fast third party | `webhook` + aggressive `backoff` |
| Multi-second / multi-minute API call | Emit an event, drain hands off to a bus; bus worker calls the API |
| Bulk fan-out (10k+ receivers) | Emit a "fanout" event, let a dedicated consumer enumerate receivers |
| Streaming / long-poll / large file transfer | Not `webhook` — write a dedicated worker |

See the forthcoming [external integration guide](https://rotorsoft.github.io/act-root/docs/guides/external-integration) (ACT-603) for the outbox pattern in detail.

### Retry & block semantics

The drain pipeline retries on `WebhookError` per the reaction's `maxRetries` and paces with `backoff`. It blocks immediately on `NonRetryableWebhookError` (when `blockOnError` is true) — no retry budget consumed.

Common shapes:

- **"Be patient with the receiver"** — `{ maxRetries: 5, backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000, jitter: true } }`. The 80% default. 5xx and network errors retry; 4xx blocks immediately.
- **"Never give up"** — `{ maxRetries: Infinity, blockOnError: false, backoff: {...} }`. For sinks that *must* eventually succeed. 4xx falls back to the same loop because `blockOnError: false` overrides the non-retryable signal.
- **"Strict — block on any failure"** — `{ maxRetries: 0 }`. Useful for endpoints with strong idempotency where any failed POST warrants operator review.

To distinguish retryable from non-retryable webhook failures in catch blocks, check both classes (or check the shared `status` field):

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

Generic catch sites can detect any handler-signaled permanent failure via `NonRetryableError` (the base class exported from `@rotorsoft/act`).

---

## `sse` — incremental state broadcast

Server-Sent Events for live UIs. Sends only the domain patches your event handlers compute, not the full state on every update.

```ts
import { BroadcastChannel, applyPatchMessage } from "@rotorsoft/act-http/sse";

// Server: after every app.do()
const snaps = await app.do(action, target, payload);
const patches = snaps.map(s => s.patch).filter(Boolean);
const state = deriveState(snaps.at(-1));
broadcast.publish(streamId, state, patches);

// Client: in your SSE handler
onData: (msg) => {
  const cached = utils.getState.getData({ streamId });
  const result = applyPatchMessage(msg, cached);
  if (result.ok) utils.getState.setData({ streamId }, result.state);
  else if (result.reason === "behind") utils.getState.invalidate({ streamId });
}
```

This subpath is a verbatim copy of `@rotorsoft/act-sse`. The standalone package still publishes; this is the consolidation point for HTTP-shaped integrations going forward. See the [SSE module docs](./src/sse/index.ts) for the full surface.

### Wire format

```ts
// Version-keyed domain patches; keys = state version after the patch applies.
{
  "5": { territories: { brazil: { armies: 3 } } },
  "6": { currentPlayerIndex: 2, phase: "reinforce" }
}
```

Multi-event commits produce multiple entries. Version gaps trigger full state refetch on the client.

---

## Why an umbrella package

SSE is HTTP (long-lived `text/event-stream` response). Webhooks are HTTP (outbound POST). They share a transport and an integration mental model, but their code surfaces are disjoint. Combining them under one package with subpath exports gives one install + one mental model ("Act over HTTP"), without conflating the two implementations.

Future HTTP-adjacent integrations (OAuth refresh, gRPC-web, signed-webhook senders) will live as additional subpaths rather than separate packages.

## Related

- [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) — core framework
- [@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg) — PostgreSQL store
- [Documentation](https://rotorsoft.github.io/act-root/)
- [Examples](https://github.com/rotorsoft/act-root/tree/master/packages)

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
