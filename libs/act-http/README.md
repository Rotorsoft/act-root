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

Three independent subpath exports:

| Import path | What you get |
|---|---|
| `@rotorsoft/act-http/webhook` | `webhook()` — reaction handler that POSTs committed events with timeout, auto `Idempotency-Key`, and status-classified errors. |
| `@rotorsoft/act-http/sse` | `BroadcastChannel`, `PresenceTracker`, `StateCache`, `applyPatchMessage` — server-side broadcast + client-side patch applicator for incremental state sync. |
| `@rotorsoft/act-http/receiver` | `receiver()` builder (high-level Hono-backed runtime) + `extractIdempotencyKey` + `verifyWebhook` + `checkWebhook` (framework-agnostic core composing both with `IdempotencyStore.claim`). |
| `@rotorsoft/act-http/receiver/trpc` | `webhookMiddleware` — tRPC middleware adapter. |
| `@rotorsoft/act-http/receiver/express` | `webhookMiddleware` — Express middleware adapter. |
| `@rotorsoft/act-http/receiver/fastify` | `webhookMiddleware` — Fastify `preHandler` adapter. |
| `@rotorsoft/act-http/receiver/hono` | `webhookMiddleware` — Hono middleware adapter. |
| `@rotorsoft/act-http/api` | `ActorExtractor` type, `ApiError` + `ERROR_MAP` + `toApiError` envelope mapping, `withIdempotency` wrapper. Shared utilities for the auto-generated API surfaces (`/trpc`, `/hono`, `/openapi` subpaths, landing under issues #843/#844/#845). |

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

### `receiver` — high-level builder (the canonical path)

The `receiver` builder from `@rotorsoft/act-http/receiver` is Hono-backed and runs on every fetch-shaped runtime — long-running Node (via `.listen()`), AWS Lambda, Cloudflare Workers, Vercel Edge, Bun, Deno (all via `.fetch()`). Declare typed handlers with Zod schemas, call `.build()`, and the runtime handles signature verification, dedup, raw-body capture, schema validation, and HTTP server lifecycle:

```ts
import { receiver } from "@rotorsoft/act-http/receiver";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { z } from "zod";

const escalations = receiver({
  port: 4001,
  store: new InMemoryIdempotencyStore(),
  secret: process.env.WEBHOOK_SECRET,
})
  .on("OrderConfirmed", z.object({ orderId: z.string(), total: z.number() }),
      async (event, ctx) => { await processOrder(event.orderId, event.total); })
  .build();

await escalations.listen();           // Node
// export default { fetch: escalations.fetch };  // Cloudflare / Vercel / Bun / Deno
```

Naming convention: type `Receiver` (PascalCase), factory `receiver` (lowercase) — matches Act's existing `act` / `state` / `slice` / `projection` builder analogs.

### `receiver/<framework>` — low-level middleware

When the receiver needs to compose with an existing HTTP stack (auth middleware, route-level rate limiting, an app already serving other routes), reach for the per-framework `webhookMiddleware` factories. They compose `extractIdempotencyKey` + `verifyWebhook` + `IdempotencyStore.claim` (a *tentative* claim — see the two-phase note below) and translate the result into the framework's idiomatic 400/401 response:

```ts
// tRPC
import { webhookMiddleware } from "@rotorsoft/act-http/receiver/trpc";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";

const dedup = new InMemoryIdempotencyStore();
const idempotent = t.procedure.use(
  webhookMiddleware({ store: dedup, secret: process.env.WEBHOOK_SECRET })
);

const router = t.router({
  webhook: idempotent.input(Schema).mutation(({ input, ctx }) => {
    const { key, deduped } = ctx.idempotency;
    if (deduped) return { status: "dedup-skipped", key };
    return { status: "processed", key };
  }),
});
```

Each adapter follows the same shape:

```ts
import { webhookMiddleware } from "@rotorsoft/act-http/receiver/express";
app.post("/webhook", webhookMiddleware({ store, secret }), async (req, res) => {
  const { key, deduped, commit, release } = (req as any).idempotency;
  if (deduped) return res.status(204).end();
  try {
    // … process the event …
    await commit();               // success — later retries dedup
    res.status(204).end();
  } catch (err) {
    await release();              // transient — the sender's retry re-processes
    res.status(500).json({ error: "handler-failed" });
  }
});
```

```ts
import { webhookMiddleware } from "@rotorsoft/act-http/receiver/fastify";
app.post("/webhook", { preHandler: webhookMiddleware({ store, secret }) }, async (req, reply) => {
  const { key, deduped, commit, release } = (req as any).idempotency;
  if (deduped) return reply.status(204).send();
  try {
    // … process the event …
    await commit();
    return reply.status(204).send();
  } catch (err) {
    await release();
    return reply.status(500).send({ error: "handler-failed" });
  }
});
```

```ts
import { webhookMiddleware } from "@rotorsoft/act-http/receiver/hono";
app.post("/webhook", webhookMiddleware({ store, secret }), (c) => {
  const { key, deduped } = c.get("idempotency");
  // Hono auto-finalizes off the response: a 2xx commits, a 5xx/throw releases.
  // …
  return c.body(null, 204);
});
```

On failure: the adapter responds with the framework's idiomatic 400 (`missing-key`) or 401 (one of five verification reasons — `missing-signature`, `missing-timestamp`, `stale`, `future`, `bad-signature`) and short-circuits the handler. On success: `{ key, deduped, commit, release }` is injected into the request context.

**Two-phase dedup.** The `claim` a middleware makes is *tentative*: it dedups a concurrent duplicate mid-flight but is not durable until confirmed, so a transient handler failure never claims-then-loses the delivery. **Hono** and **tRPC** wrap the downstream chain and finalize automatically (2xx / resolved → `commit`; 5xx / thrown / `{ ok: false }` → `release`). **Express** and **Fastify** middleware complete before the route handler, so the handler must call `commit()` on success or `release()` on a transient failure — skipping both leaves the claim tentative (dedups concurrent duplicates, expires on TTL, never permanently lost).

### `receiver` primitives — when neither builder nor middleware fits

The framework-agnostic core (`checkWebhook`) and the underlying primitives (`extractIdempotencyKey`, `verifyWebhook`) are exported from `@rotorsoft/act-http/receiver` for receivers whose framework isn't in the adapter list (Koa, raw Node `http`, gRPC-over-HTTP, …) or for receivers with custom policy (e.g. "missing key falls back to body-derived dedup"). Use the `receiver` builder when you can; fall back to the framework `webhookMiddleware`, then the primitives.

### `trpc` — auto-generated tRPC router

```ts
import { trpc } from "@rotorsoft/act-http/trpc";
import { initTRPC } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";

const router = trpc(app, {
  // ActorExtractor from `@rotorsoft/act-http/api` — host's auth seam.
  actor: (ctx) => ({ id: ctx.user.id, name: ctx.user.name }),
  // Resolve the target stream per call; singleton aggregates return a constant.
  stream: (action, input, ctx) => `tenant-${ctx.tenant}`,
  // Optional optimistic concurrency — return `undefined` to skip the check.
  expectedVersion: (action, input, ctx) => readIfMatchHeader(ctx),
});

createHTTPServer({ router }).listen(4000);

// Client (same types, no codegen):
// await client.OpenTicket.mutate({ title: "support" });
```

The generator walks `app.registry.actions` once and emits a flat top-level mutation per action. The internal `authenticated(extractor)` middleware runs `options.actor` once per call and injects the resolved `Actor` onto `ctx.actor`, so any procedure logic downstream of the chain sees the same actor. `actor` and `stream` are required; `idempotency` is optional — when configured, the mutation reads `Idempotency-Key` via `keyFrom(ctx)` and throws `CONFLICT` on duplicate claims (the contract intentionally doesn't cache original results, matching the receiver-side "ack the duplicate" semantics).

Errors map through the shared `toApiError(...)` table at `@rotorsoft/act-http/api`: `ConcurrencyError` → `CONFLICT`, `InvariantError` → `CONFLICT`, `ValidationError` → `UNPROCESSABLE_CONTENT`, `StreamClosedError` → `PRECONDITION_FAILED`, `NonRetryableError` → `BAD_REQUEST`, anything else → `INTERNAL_SERVER_ERROR`. The same envelope flows from every transport sibling so a client speaking two of them never sees two shapes for the same framework error.

```ts
// Compose the auth middleware into your own procedure chain instead:
import { authenticated } from "@rotorsoft/act-http/trpc";

const t = initTRPC.context<MyCtx>().create();
const authed = t.procedure.use(authenticated(myExtractor));
// `authed` carries `ctx.actor: Actor` downstream — use it for hand-written
// procedures alongside the generated ones.
```

### `hono` — auto-generated REST surface

```ts
import { hono } from "@rotorsoft/act-http/hono";
import { serve } from "@hono/node-server";

const api = hono(app, {
  // ActorExtractor from `@rotorsoft/act-http/api` — host's auth seam.
  actor: (c) => resolveActorFromJwt(c),
  // Resolve the target stream per call; singleton aggregates return a constant.
  stream: (action, input, c) => `tenant-${c.req.header("x-tenant")}`,
  // Optional optimistic concurrency — return `undefined` to skip the check.
  expectedVersion: (action, input, c) => {
    const v = c.req.header("if-match");
    return v ? Number.parseInt(v, 10) : undefined;
  },
});

serve({ fetch: api.fetch, port: 4000 });
// POST /api/actions/OpenTicket  body: { title }
// → 200 [Snapshot] | 4xx ApiError envelope
```

The generator walks `app.registry.actions` once and registers one `POST /actions/<actionName>` per action under the configured `basePath` (default `/api`). Bodies are validated with `@hono/zod-validator` against the action's registered Zod schema; failures short-circuit with `400`. The internal `authenticated(extractor)` middleware runs `options.actor` once per request and stashes the resolved `Actor` under `c.get("actor")`, available to any downstream middleware (logging, tracing, hand-written routes mounted on the same Hono instance). `Idempotency-Key` is read from the request header by default; `keyFrom` overrides for hosts that prefer a custom convention.

Errors map through the shared `toApiError(...)` table at `@rotorsoft/act-http/api`: `ConcurrencyError → 412 / CONCURRENCY`, `InvariantError → 409 / INVARIANT`, `ValidationError → 422 / VALIDATION`, `StreamClosedError → 410 / STREAM_CLOSED`, `NonRetryableError → 400 / NON_RETRYABLE`. The envelope (`{ error, detail?, code? }`) is the same shape every other act-http transport ships so a client speaking REST plus tRPC never sees two formats for the same framework error.

Edge-runtime ready — Hono runs unchanged on Node, Bun, Cloudflare Workers, Vercel Edge, and AWS Lambda. Operators wiring `idempotency` on edge runtimes should verify the `IdempotencyStore` is edge-compatible (in-memory works per worker; cross-worker requires a distributed store).

```ts
// Compose the auth middleware into your own Hono chain instead:
import { Hono } from "hono";
import { authenticated, type ActMiddlewareVariables } from "@rotorsoft/act-http/hono";

const api = new Hono<{ Variables: ActMiddlewareVariables }>();
api.use("*", authenticated((c) => resolveActorFromJwt(c)));
// Hand-written routes alongside the generated ones now see c.get("actor") typed.
```

### `openapi` — OpenAPI 3.1 document emitter

```ts
import { openapi } from "@rotorsoft/act-http/openapi";

const doc = openapi(app, {
  info: { title: "Wolfdesk API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  // Document the optional cross-cutting headers that the live REST API accepts.
  idempotency: true,
  expectedVersion: true,
});

// Serve alongside the Hono adapter:
api.get("/openapi.json", (c) => c.json(doc));
```

Pure data emit — no runtime dep on Hono or tRPC. The doc walks `app.registry.actions` once at function call and emits one `POST <basePath>/actions/<actionName>` operation per action, deriving the request-body schema from each action's Zod definition via Zod 4's native `z.toJSONSchema` (OpenAPI 3.1 uses JSON Schema 2020-12 as its schema dialect — no conversion layer needed).

**The doc describes the Hono REST surface, not tRPC.** tRPC's URL convention (`POST /trpc/<procedure>`, JSON-RPC-style body framing, batching) doesn't model cleanly as OpenAPI operations; tRPC consumers share types directly via `typeof router` and don't need a doc. The path shape this emitter produces matches `@rotorsoft/act-http/hono` by construction: same default `basePath` (`/api`), same request/response shapes, same error envelope. If the operator overrides `basePath` on the Hono adapter, pass the same value here so the doc keeps describing the live routes. tRPC and Hono can run side-by-side at different mount points on the same Act instance.

The same shared `ApiError` envelope underwrites cross-transport consistency: it's referenced once from `components.responses` and every error code (`400`, `409`, `410`, `412`, `422`, `500`) points at it. The doc and the live REST API agree on framework-error shapes by construction.

Output is deterministic given the same registry — entries land in `Object.entries(app.registry.actions)` iteration order. CI can snapshot the result to catch unintended API-surface changes; one merge that quietly changes a Zod schema or adds a new action surfaces as a doc diff in the same PR.

### `trpc` + `hono` SSE subscriptions — live state from the generators

Both generators accept an optional `sse` option that walks the registry once and emits a typed subscription per unique state name, all reading from a host-supplied `BroadcastChannel`. Hosts continue to own publication (`channel.publish(streamId, state, patches)` after each `app.do(...)`); the generators own subscription, accounting, cleanup, and the wire format.

```ts
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { trpc } from "@rotorsoft/act-http/trpc";
import { hono } from "@rotorsoft/act-http/hono";

const broadcast = new BroadcastChannel<MyState>();

// Server-side: after every app.do(...), publish the derived state.
const snaps = await app.do(action, target, payload);
broadcast.publish(target.stream, deriveState(snaps), snaps.map((s) => s.patch).filter(Boolean));

// tRPC — emits `router.subscribe.<stateName>.useSubscription({ stream })`.
const router = trpc(app, {
  actor,
  stream,
  sse: { channel: broadcast, maxConnections: 500, heartbeatMs: 30_000 },
});

// Hono — emits `GET /api/sse/<stateName>?stream=<id>` per registered state.
const api = hono(app, {
  actor,
  stream,
  sse: { channel: broadcast },
});
```

Defaults are sized for typical business-app dashboards: `maxConnections = 500` (range `[1, 10_000]`), `heartbeatMs = 30_000` (range `[15_000, 300_000]`), `maxPendingPerConnection = 256` (range `[1, 100_000]`). The 501st concurrent open returns `503 / SSE_BUSY` with `Retry-After: 1` (Hono) or throws `TOO_MANY_REQUESTS` (tRPC). Each connection's undelivered-frame backlog is bounded by `maxPendingPerConnection`: a stalled consumer on a busy stream drops its oldest queued frame (drop-oldest) rather than growing memory without bound — each frame is a full version-keyed patch, so the consumer still converges on current state. Streams cleaned up via the consumer's `iter.return()` / disconnect both run the loop's `finally` block: unsubscribe from the channel, release the slot (only if one was acquired), clear the heartbeat. See [@rotorsoft/act-http/sse](#sse--live-state-broadcast) below for the channel/cache primitives this wires.

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
- **`tryOk(response, { url, label? })`** — collapses the classify-and-throw block to one line for **custom HTTP-like reactions** (gRPC bridges, SDK-based deliveries). Returns void on 2xx; throws `RetryableHttpError` on 5xx; throws `NonRetryableHttpError` on 3xx/4xx. Captures the response body (best-effort) onto the thrown error.
- **`classifyHttpResponse(response)`** — the underlying `"ok" | "retry" | "block"` classifier. Reach for it directly when you need custom error classes; otherwise `tryOk` wraps it.
- **`RetryableHttpError`** — generic retryable delivery error. Extends `Error`. Thrown by `tryOk` on 5xx. `WebhookError` extends it.
- **`NonRetryableHttpError`** — generic non-retryable delivery error. Extends `NonRetryableError` from `@rotorsoft/act`, so the drain finalizer blocks the stream on first failed attempt. Thrown by `tryOk` on 3xx/4xx. `NonRetryableWebhookError` extends it.
- **`WebhookError`** — webhook-specific subclass of `RetryableHttpError`, thrown by the `webhook` helper. Existing `instanceof WebhookError` checks continue to work; new code targeting any HTTP integration can catch `RetryableHttpError` to handle both webhook + custom-integration errors uniformly.
- **`NonRetryableWebhookError`** — webhook-specific subclass of `NonRetryableHttpError`, thrown by `webhook` on 3xx/4xx. Same backward-compat story as `WebhookError`.
- **`WebhookConfig`** — TypeScript type for the helper options.
- **`HttpDisposition`** — the `"ok" | "retry" | "block"` discriminator returned by `classifyHttpResponse`.
- **`HttpDeliveryErrorInit`** — common `{ status, url, responseBody? }` shape passed to every HTTP error class.
- **`TryOkOptions`** — `{ url, label? }` shape passed to `tryOk`.

### `/receiver` subpath

- **`checkWebhook(headers, body, options)`** — framework-agnostic core. Composes `verifyWebhook` (when `options.secret` is set) + `extractIdempotencyKey` + `options.store.claim` (a *tentative* claim). Returns `{ ok: false; status: 400|401; reason }` on failure or `{ ok: true; key; deduped }` on success. The caller owns finalization: `options.store.commit(key)` on handler success, `options.store.release(key)` on a transient failure. The per-framework adapters wrap this and translate the outcome into the framework's idiomatic response.
- **`extractIdempotencyKey(headers)`** — case-insensitive `Idempotency-Key` header parser. Returns `undefined` when the header carries no usable key: missing, array-valued (ambiguous), or empty string. Validation beyond "is there a usable key?" (length, format) is intentionally out of scope.
- **`verifyWebhook(headers, body, secret, opts?)`** — HMAC-SHA256 signature + timestamp window verifier. Returns `{ ok: true }` or `{ ok: false; reason }` where reason is one of `missing-signature` / `missing-timestamp` / `stale` / `future` / `bad-signature`. Default timestamp window is ±300 seconds; override via `opts.maxAgeSeconds`. Uses `crypto.timingSafeEqual` to avoid timing attacks. Pair with `webhook({ secret })` on the sender side.
- **Types**: `CheckResult`, `CheckWebhookOptions`, `CheckFailureReason`, `VerifyResult`, `VerifyOptions`.

### `/receiver/<framework>` subpaths

Each framework adapter exports a single function `webhookMiddleware(options)` that returns the framework's native middleware shape. Options are `{ store, secret?, verify? }` — the same `CheckWebhookOptions` as the core. Failure → 400/401 with `{ error: <reason> }`; success → `{ key, deduped, commit, release }` is injected. Hono and tRPC auto-finalize off the downstream outcome; Express and Fastify require the route handler to call `commit()` / `release()` (see the two-phase note above):

| Subpath | Injection site | Failure response |
|---|---|---|
| `/receiver/trpc` | `ctx.idempotency` | throws `TRPCError({ code, message: reason })` |
| `/receiver/express` | `req.idempotency` | `res.status(...).json({ error: reason })` |
| `/receiver/fastify` | `request.idempotency` | `reply.status(...).send({ error: reason })` |
| `/receiver/hono` | `c.get("idempotency")` (typed via `Variables`) | `c.json({ error: reason }, status)` |

### `/api` subpath

Shared utilities consumed by every transport in the auto-generated API umbrella (act-http-api epic #835). Three concerns surfaced once, not per-transport:

- **`ActorExtractor`** — type alias `(request: unknown) => Actor | Promise<Actor>`. The host-supplied closure resolving an `Actor` from an incoming request. Required on every transport (`trpc(app, { actor })`, `hono(app, { actor })`). Auth (JWT, session, API key) stays in the host; the package only asks for this function.
- **`ApiError`** — uniform envelope `{ error, detail?, code? }` shipped over the wire by every transport. Hosts get the same shape from REST, tRPC, and OpenAPI.
- **`ERROR_MAP`** — `as const` table mapping framework error types to `{ status, code }`. `ValidationError → 422 / VALIDATION`, `InvariantError → 409 / INVARIANT`, `ConcurrencyError → 412 / CONCURRENCY`, `StreamClosedError → 410 / STREAM_CLOSED`, `NonRetryableError → 400 / NON_RETRYABLE`.
- **`toApiError(err) → { status, body }`** — the single mapping helper every transport calls in its error boundary. Known framework errors map per `ERROR_MAP`; everything else surfaces as 500 / `INTERNAL` (with `detail` only when the throw was an `Error` — thrown strings or objects don't leak payloads).
- **`withIdempotency(store, key, handler)`** — wraps an action handler in a two-phase `Idempotency-Key` claim: it `claim`s tentatively, runs the handler, then `commit`s the key on success or `release`s it and re-throws on a handler rejection (so a transient failure re-processes on retry rather than deduping into a silent success). Reuses `@rotorsoft/act-ops/idempotency` — same contract `@rotorsoft/act-http/receiver` already speaks, so one `IdempotencyStore` covers both halves of the "Act over the wire" surface. Returns `{ deduped: false, result }` on fresh claim, `{ deduped: true }` on duplicate (handler is not called).
- **`SseOptions`** — `{ channel: BroadcastChannel<S>, maxConnections?, heartbeatMs?, maxPendingPerConnection? }`. Shared SSE wiring options consumed by both `trpc(app, { sse })` and `hono(app, { sse })`. Defaults: `maxConnections=500` (validated `[1, 10_000]`), `heartbeatMs=30_000` (validated `[15_000, 300_000]`), `maxPendingPerConnection=256` (validated `[1, 100_000]`). Out-of-range values throw `RangeError` at transport construction so misconfiguration surfaces at startup, not at first connection.
- **`SseConnectionCounter`** — per-process slot counter. The 501st concurrent open is refused (`503 / SSE_BUSY` with `Retry-After: 1` on Hono, `TOO_MANY_REQUESTS` on tRPC). Internal — both transports construct one each, shared by every state-name's subscription on a single generator instance.
- **`runSseSubscription(channel, streamId, accounting?, signal?, on_cap_exceeded?)`** — the shared subscription loop both transports run. Acquires one slot (when an `accounting` is supplied), yields the cached state if present, then forwards every channel publication as a `{ kind: "patch", data }` frame until the consumer breaks or the signal aborts. Used internally; exported for adopters who want to build their own transport surface against the same accounting / cancellation discipline.
- **`resolveSseConfig(options)`** + **`DEFAULT_SSE_HEARTBEAT_MS`** / **`DEFAULT_SSE_MAX_CONNECTIONS`** — validation helper and exposed defaults.
- **Types**: `IdempotencyResult<T>`, `ErrorMapEntry`, `SseConfig`, `SseAccounting`, `SseSubscriptionFrame<S>`.

### `/trpc` subpath

Auto-generated tRPC router for the act-http-api epic (#835).

- **`trpc(app, options) → Router`** — generator function. Walks `app.registry.actions` once and emits a flat top-level mutation per action. Each procedure runs the internal `authenticated(options.actor)` middleware (so `ctx.actor: Actor` is set on the downstream context), resolves the target stream via `options.stream(action, input, ctx)`, and calls `app.do(action, { stream, actor }, input)`. Known framework errors map through `toApiError` to the conventional tRPC codes; unknown throws surface as `INTERNAL_SERVER_ERROR`.
- **`authenticated(extractor) → middleware`** — standalone export of the auth middleware the generator uses internally. Hosts composing their own procedure chain (logging + tracing + custom auth flavors) use `t.procedure.use(authenticated(extractor))` to inject `ctx.actor` without going through the generator. The middleware is structurally-typed so any host `t` instance accepts it.
- **`TrpcOptions<Ctx>`** — `{ actor, stream, expectedVersion?, idempotency?, sse? }`. `actor` is the `ActorExtractor` from `@rotorsoft/act-http/api`. `stream` returns the target stream per call. `expectedVersion` is optional — `(action, input, ctx) => number | undefined` — when set, the procedure threads the resolved value through `Target.expectedVersion` so `app.do` enforces optimistic concurrency; hosts typically read it from an `If-Match` header or the client's last-known snapshot, and returning `undefined` skips the check for that call. `idempotency` is optional — `{ store: IdempotencyStore; keyFrom: (ctx) => string | undefined }` — when set, the procedure honors `Idempotency-Key` via `withIdempotency`. Duplicate claims throw `CONFLICT` (the contract intentionally doesn't cache the original handler's result). `sse` is optional — when set, the generator emits one subscription per unique registered state name under the nested `router.subscribe.<stateName>` namespace; each yields `{ kind: "state", data }` once (when the channel has a cached state) and then `{ kind: "patch", data }` per channel publication until the consumer breaks. The cap surfaces as `TOO_MANY_REQUESTS`.

### `/hono` subpath

Auto-generated REST surface for the act-http-api epic (#835).

- **`hono(app, options) → Hono`** — generator function. Walks `app.registry.actions` once and registers a `POST /actions/<actionName>` per action under `basePath` (default `/api`). Body is validated with `@hono/zod-validator` against the action's Zod schema; failures short-circuit with `400`. The internal `authenticated(options.actor)` middleware stashes the resolved `Actor` under `c.get("actor")`. Routes return `200 Snapshot[]` on success, `4xx ApiError` envelope (with the conventional HTTP status) on framework errors, `500 / INTERNAL` on unknown throws.
- **`authenticated(extractor) → MiddlewareHandler`** — standalone export of the auth middleware the generator uses internally. Hosts composing their own Hono chain wire `api.use("*", authenticated(extractor))` and downstream routes read `c.get("actor"): Actor`. Errors thrown by the extractor surface as `401 / UNAUTHORIZED`.
- **`HonoOptions`** — `{ actor, stream, expectedVersion?, idempotency?, sse?, basePath? }`. `actor` is the `ActorExtractor`. `stream` returns the target stream per call. `expectedVersion` threads `Target.expectedVersion` for optimistic concurrency — returning `undefined` skips the check. `idempotency` is optional — `{ store: IdempotencyStore; keyFrom?: (c) => string | undefined }` — when set, the route honors `Idempotency-Key` via `withIdempotency`; default `keyFrom` reads the `Idempotency-Key` header. Duplicate claims return `409 / CONFLICT`. `sse` is optional — when set, the generator emits one `GET <basePath>/sse/<stateName>?stream=<id>` route per unique registered state name; each route opens a `text/event-stream`, yields the cached state (`event: state`) when present, then forwards every channel publication as `event: patch`. The connection cap surfaces as `503 / SSE_BUSY` with `Retry-After: 1`. A heartbeat ping every `heartbeatMs` keeps proxies from idling the connection out. `basePath` defaults to `/api`.
- **`ActMiddlewareVariables`** — `{ actor: Actor }`. Use as the `Variables` generic on a host Hono instance to get `c.get("actor")` typed downstream of `authenticated`.

### `/openapi` subpath

OpenAPI 3.1 document emitter for the act-http-api epic (#835).

- **`openapi(app, options) → OpenAPIDocument`** — generator function. Walks `app.registry.actions` once and returns a valid OpenAPI 3.1 document object. Each action becomes a `POST <basePath>/actions/<actionName>` operation; the request-body schema comes from Zod 4's `z.toJSONSchema` against the action's registered schema. Error responses reference the shared `#/components/responses/ApiError`. Output is pure data — serve as `/openapi.json`, write to disk during CI, pipe to client codegen.
- **`OpenAPIOptions`** — `{ info, servers?, basePath?, idempotency?, expectedVersion? }`. `info.title` and `info.version` are required non-empty strings. `servers[].url` may contain `{variable}` template syntax; bare URLs are validated through `URL`'s parser. `basePath` defaults to `/api` (mirrors the Hono sibling). `idempotency` and `expectedVersion` are booleans (default `false`); when `true`, every mutation operation documents the corresponding header — `Idempotency-Key` is marked **required** (the route 400s without it), `If-Match` is optional.
- **`OpenAPIDocument`** + a structural subset of the OpenAPI 3.1 types (`OpenAPIInfo`, `OpenAPIServer`, `OpenAPIPathItem`, `OpenAPIOperation`, `OpenAPIParameter`, `OpenAPIRequestBody`, `OpenAPIResponse`, `OpenAPIComponents`). Intentionally lighter than the full `openapi-types` package so post-processing doesn't fight the type system; cast to a fuller type when downstream consumers need it.

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
| `secret` | `string` | unset (unsigned) |
| `fetch` | `typeof fetch` | `globalThis.fetch` |

Strings as `body` are sent as-is; anything else is `JSON.stringify`'d and `Content-Type: application/json` is set automatically (unless the caller supplies it).

A caller-supplied `Idempotency-Key` header (case-insensitive) always wins; the auto-derived `event.id` is only applied when the header is absent. `event.id` is the framework's immutable, per-event monotonic integer — well-suited to downstream dedup.

When `secret` is set, the helper signs each request with HMAC-SHA256 over `${timestamp}.${body}` (the final serialized body) and attaches `X-Webhook-Signature: sha256=<hex>` + `X-Webhook-Timestamp: <unix-seconds>`. Caller-supplied versions of either header (case-insensitive) win, the same way the `Idempotency-Key` and `Content-Type` defaults yield to caller intent. Pair with `verifyWebhook` from `@rotorsoft/act-http/receiver` on the receiving side — the protocol matches Stripe / GitHub / Slack conventions modulo the `X-Webhook-*` prefix.

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

- **[Auto-generated API surfaces](https://rotorsoft.github.io/act-root/docs/guides/auto-generated-api)** — narrative walkthrough of the `/trpc`, `/hono`, `/openapi` subpaths plus the shared utilities at `/api`. Authentication seam, idempotency, optimistic concurrency, deployment recipes (Node, Lambda, Cloudflare, Next.js), and migrating from a hand-written router.
- **[External integration patterns](https://rotorsoft.github.io/act-root/docs/guides/external-integration)** — inline `webhook` vs forwarded bus, receiver-side idempotency contract, the recovery loop.
- **[Real-time with SSE](https://rotorsoft.github.io/act-root/docs/concepts/real-time)** — concept guide for the `/sse` surface.
- **[Error handling](https://rotorsoft.github.io/act-root/docs/concepts/error-handling)** — backoff, `NonRetryableError`, blocked streams, `unblock` recovery.

## License

MIT
