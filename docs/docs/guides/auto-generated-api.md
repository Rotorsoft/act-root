---
id: auto-generated-api
title: Auto-generated API surfaces
description: Turning a built Act registry into tRPC + REST + OpenAPI without hand-writing routes.
sidebar_position: 3.5
---

# Auto-generated API surfaces

An Act app is a registry of typed actions. Each action has a Zod schema for its input, a target stream, and an `app.do(action, target, payload)` dispatch — so any HTTP transport that wraps it ends up doing the same handful of things: extract an actor, resolve a stream, validate the body, dispatch, map errors. The shape is mechanical. Hand-writing it three times — once as a tRPC procedure, once as an Express route, once as an OpenAPI document — is wasted work that drifts.

`@rotorsoft/act-http` ships three generators that walk the registry once at startup and emit each transport from the same source of truth: `/trpc`, `/hono`, `/openapi`. All three compose the shared utilities at `@rotorsoft/act-http/api` — one actor extractor type, one error envelope, one `Idempotency-Key` wrapper — so a client speaking two transports sees one shape for every framework error.

This guide walks through the why, the three subpaths, the shared utilities they all share, the authentication seam, deployment recipes, how event versioning surfaces, and how to migrate a hand-written router onto the generator.

## What this guide answers

- Why are transport routes worth generating instead of hand-writing?
- Which subpath do I pick — tRPC, Hono REST, OpenAPI, or all three?
- Where does authentication go, and how do I keep auth flexible across transports?
- How do I deploy on Node, Lambda, Cloudflare Workers, or alongside Next.js?
- How does `_v<n>` event versioning surface in the generated API?
- How do I migrate a hand-written router onto the generator?

The companion API reference is [`@rotorsoft/act-http`'s README](https://github.com/Rotorsoft/act-root/tree/master/libs/act-http) — surface details for every option live there. This page is the narrative.

## Why generated

The promise of the registry is that "an action is its Zod schema plus its target". Once that's true, every transport-layer concern is derivable:

| Step | What every transport does | Where it differs |
|---|---|---|
| Resolve actor | Read auth context, produce an `Actor` | Header parsing per framework |
| Resolve stream | Decide which aggregate this call targets | Always app-specific |
| Validate body | Run the action's Zod schema against the request payload | Each framework has its own validator hook |
| Dispatch | `app.do(action, { stream, actor, expectedVersion? }, input)` | Identical |
| Map errors | Translate framework errors into HTTP status + machine code | Identical (the table is in `@rotorsoft/act-http/api`) |
| Optional idempotency | Claim an `Idempotency-Key`; refuse a committed duplicate, ask an in-flight one to retry | Identical |

Five of those six rows are identical across transports. The remaining row — resolving actor and stream — gets parameterized as two functions that the host supplies. Everything else is one mechanical loop over `app.registry.actions`.

That's all the generators do. There's no codegen step, no schema generator, no second source file to keep in sync. The Zod schemas you already wrote against your actions and events drive the wire format directly.

## Quick start — one Act, a server and a typed client

The shape of the calculator demo in this repo (`packages/calculator`, `packages/server`, `packages/client`), cut to its minimum. The server generates every transport from the app and exports their types; the client imports those types and nothing else, the way a tRPC client imports `typeof appRouter`. No codegen, and no type written by hand on either side.

**The app** — your domain, untouched by transport concerns:

```ts no-check
// calculator/src/index.ts
import { act } from "@rotorsoft/act";
import { Calculator } from "./calculator.js";

export const calculatorApp = act().withState(Calculator).build();
```

**The server** — generate, export the types, mount:

```ts no-check
// server/src/api.ts
import { calculatorApp } from "@act/calculator";
import { hono } from "@rotorsoft/act-http/hono";
import { openapi } from "@rotorsoft/act-http/openapi";
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { trpc } from "@rotorsoft/act-http/trpc";

const actor = (ctx: unknown) => resolveActorFromJwt(ctx); // throw to deny
const stream = () => "calculator";
const sse = { channel: new BroadcastChannel() }; // publish commits to it

export const router = trpc(calculatorApp, { actor, stream, sse }); // tRPC
export const api = hono(calculatorApp, { actor, stream, sse }); // REST + SSE
export const doc = openapi(calculatorApp, {
  info: { title: "Calculator API", version: "1.0.0" },
});

export type AppRouter = typeof router;
export type Api = typeof api;

// server/src/server.ts
const app = new Hono();
app.route("/", api); // POST /api/actions/<action>, GET /api/sse/<state>
app.all("/trpc/*", (c) =>
  fetchRequestHandler({ endpoint: "/trpc", req: c.req.raw, router })
);
app.get("/openapi.json", (c) => c.json(doc));
serve({ fetch: app.fetch, port: 4000 });
```

**The client** — import the types only:

```tsx no-check
import type { Api, AppRouter } from "@act/server";
import { createTRPCReact } from "@trpc/react-query";
import { hc } from "hono/client";

export const trpc = createTRPCReact<AppRouter>();
export const rest = hc<Api>("http://localhost:4000");

// tRPC: payload checked, snapshots typed
const pressKey = trpc.PressKey.useMutation({
  onSuccess: ([snap]) => show(snap.state.result), // number
});
pressKey.mutate({ key: "7" });

// REST: the same, through Hono's client
const res = await rest.api.actions.PressKey.$post({ json: { key: "7" } });
if (res.ok) show((await res.json())[0].state.result);
else console.error((await res.json()).detail); // ApiError

// Live state: one typed subscription per state
trpc.subscribe.Calculator.useSubscription(
  { stream: "calculator" },
  { onData: (frame) => (frame.kind === "state" ? seed(frame.data) : patch(frame.data)) }
);
```

Add an action to the Calculator and every transport picks it up on the next build. A client that calls it wrong, or reads a field the state doesn't have, stops compiling. Non-TypeScript clients generate from `/openapi.json`, whose responses are typed per state as well. The full, runnable version is `pnpm dev:http`; `packages/client/src/Calculator.tsx` shows the live panel's patch handling with `applyPatchMessage`.

## The three subpaths

### `@rotorsoft/act-http/trpc`

The generator emits a flat router — one mutation per registered action, keyed by the action name:

```ts no-check
type Ctx = { user: { id: string; name: string }; tenant: string };

const router = trpc<Ctx, typeof app>(app, {
  actor: (ctx) => ({ id: ctx.user.id, name: ctx.user.name }),
  stream: (action, input, ctx) => `tenant-${ctx.tenant}`,
  expectedVersion: (action, input, ctx) => readIfMatchHeader(ctx),
});

// Client side, no codegen:
const client = createTRPCClient<typeof router>({ links });
const [snap] = await client.OpenTicket.mutate({ title: "support" });
snap.state.title; // string
```

The router is typed from the app. Each mutation takes its action's payload and returns the snapshots `app.do` returns, as they arrive over JSON (dates are strings). With `sse`, each `subscribe.<state>` yields that state's frames. A wrong field or an unknown action fails to compile, in `createTRPCClient` and `createTRPCReact` alike. The `stream` and `expectedVersion` resolvers get the action's name and its payload together, on both generators, so checking `action` narrows `input`; declare all three parameters (`(action, input, ctx)`) for TypeScript to narrow. Pass `typeof app` whenever you pass `Ctx`: given one type argument, TypeScript doesn't infer the other, and an app it can't see has no types to give.

The router is **flat by design**. State-name grouping (e.g. `client.Tickets.OpenTicket`) was considered and dropped — action names are unique across a registry (the framework enforces no duplicates at build), and the extra nesting was overhead that bought nothing.

Errors map through `toApiError(...)` from `@rotorsoft/act-http/api` **by error identity**, so the tRPC wire status matches the Hono/OpenAPI status for the same framework error ([the table](#apierror-envelope--error_map--toapierror)). The one unavoidable difference is `StreamClosedError`: tRPC has no 410 code, so it maps to `NOT_FOUND` (404), the closest "the resource is gone" semantics. Mapping by identity rather than by round-tripping the HTTP status is what keeps the two transports in agreement.

A **malformed request body** takes the same route: the generator validates the payload inside the resolver (not via tRPC's `.input()`, whose Zod failure is a hardcoded `BAD_REQUEST`/400 that never reaches `toApiError`), so a body that fails an action's Zod schema surfaces as the same `ValidationError → UNPROCESSABLE_CONTENT` (422) a malformed `app.do` payload raises — matching Hono's `422 / VALIDATION` for the same input ([#1295](https://github.com/Rotorsoft/act-root/issues/1295)).

That up-front parse is only a gate. The `stream` and `expectedVersion` resolvers receive its parsed value, but `app.do` receives the **raw** request body and parses it once itself. Handing it the already-parsed value would run a schema's `.transform()` twice, so a "dollars on the wire, cents in the domain" transform would store 100× the amount, and a type-changing `.pipe()` would reject every request ([#1739](https://github.com/Rotorsoft/act-root/issues/1739)). The Hono generator does the same, taking the raw body from the same place its JSON validator did: a request without a JSON `Content-Type` is validated, resolved and executed as `{}`, never re-read ([#1777](https://github.com/Rotorsoft/act-root/issues/1777)).

### `@rotorsoft/act-http/hono`

Same registry, same options shape, REST instead of RPC:

```ts no-check
import { hono } from "@rotorsoft/act-http/hono";
import { serve } from "@hono/node-server";

const api = hono(app, {
  actor: (c) => resolveActorFromJwt(c),
  stream: (action, input, c) => `tenant-${c.req.header("x-tenant")}`,
  expectedVersion: (action, input, c) => {
    const v = c.req.header("if-match");
    return v ? Number.parseInt(v, 10) : undefined;
  },
});

serve({ fetch: api.fetch, port: 4000 });
// POST /api/actions/OpenTicket  body: { title }  → 200 Snapshot[] | 4xx ApiError

// Client side, typed from the same app:
const client = hc<typeof api>("http://localhost:4000");
const res = await client.api.actions.OpenTicket.$post({ json: { title: "support" } });
if (res.ok) (await res.json())[0].state.title; // string
else (await res.json()).code; // ApiError
```

The returned app's type lists every route: each action's payload as the JSON body, the snapshots on `200` and `ApiError` on an error status, and with `sse` the `GET /sse/<state>` routes. So `hc<typeof api>` and `testClient(api)` are typed with no casts. The `authenticated` middleware's `401` reaches a typed client when it is mounted on the route (`api.get("/me", authenticated(extract), handler)`); mounted with `api.use`, it works the same but the route's type doesn't list the `401`.

The generator registers one `POST /actions/<actionName>` per action under `basePath` (default `/api`). `@hono/zod-validator` runs each action's registered Zod schema against the request body; a body-schema failure, or a JSON body that doesn't parse, short-circuits with `422 / VALIDATION` and the shared `ApiError` envelope — the same status and shape a `ValidationError` thrown inside `app.do` maps to, so a client parsing `ApiError` sees one shape for both. Other errors map through `toApiError` ([the table](#apierror-envelope--error_map--toapierror)).

Edge-runtime ready — Hono runs unchanged on Node, Bun, Cloudflare Workers, Vercel Edge, AWS Lambda, Deno. If you wire `idempotency`, verify the `IdempotencyStore` is edge-compatible: in-memory works per worker, cross-worker requires a distributed store.

### `@rotorsoft/act-http/openapi`

A pure-data emitter — no runtime dep on Hono or tRPC. Returns an OpenAPI 3.1 document object you can serialize and serve, or pass to a docs renderer:

```ts no-check
import { openapi } from "@rotorsoft/act-http/openapi";

const doc = openapi(app, {
  info: { title: "Wolfdesk API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  idempotency: true,
  expectedVersion: true,
});

// Serve alongside the Hono adapter:
api.get("/openapi.json", (c) => c.json(doc));
```

**The doc describes the Hono REST surface, not tRPC.** tRPC's URL convention (`POST /trpc/<procedure>`, JSON-RPC-style body framing, batching) doesn't model cleanly as OpenAPI operations; tRPC consumers share types directly via `typeof router` and don't need a doc. The path shape this emitter produces matches `@rotorsoft/act-http/hono` by construction: same default `basePath` (`/api`), same request/response shapes, same error envelope. If you override `basePath` on the Hono adapter, pass the same value here so the doc keeps describing the live routes.

Zod 4's native `z.toJSONSchema` does the schema conversion — OpenAPI 3.1 uses JSON Schema 2020-12 as its dialect, so there's no lossy translation layer. The output is deterministic given the same registry (entries land in `Object.entries(app.registry.actions)` iteration order), so CI can snapshot the result and catch unintended API-surface changes in the same PR that introduced them.

**Sensitive input fields are marked.** `z.toJSONSchema` has no knowledge of the `sensitive()` registry — the marker lives out-of-band in a `WeakMap`. So the emitter walks each action's sensitive fields (via `pii_fields` from `@rotorsoft/act`) and annotates every matching request-body property `writeOnly: true` + `format: password`. A field declared `email: sensitive(z.string())` surfaces in the doc as a write-only secret, so codegen tools and Swagger UI's "Try It" panel treat it as a password rather than echoing it in cleartext. In responses, a sensitive field may read as `[REDACTED]` or `[SHREDDED]` for a caller who may not see it, so its schema there is the field's own or one of those two strings.

**Responses are typed per state.** Each action's `200` points at `<State>Snapshots`, built from the state's Zod schema and its events': `state` as the state schema, `event` as one shape per event the state emits (told apart by `name`, with its `data` schema), and `patch` as the state schema with every field optional or `null`. A sensitive field in an event's `data` may read as `[REDACTED]` or `[SHREDDED]`, and so may every field of a state with sensitive events: a reducer can copy a hidden value into a state field of any name. A client generated from the document (`openapi-typescript` with `openapi-fetch`, or any language's generator) gets typed snapshots, as a tRPC or `hc` client does. `SnapshotArray`, the open shape, stays for an app surface that carries no state schemas.

A clean way to serve the doc plus an interactive explorer in one shot — Scalar reads the live document from the same server:

```ts no-check
api.get("/openapi.json", (c) => c.json(doc));
api.get("/docs", (c) =>
  c.html(`<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body></html>`)
);
```

`packages/server` in this repo uses exactly this pattern.

## Shared utilities — `@rotorsoft/act-http/api`

Three concerns surface in every transport. Defining them once at `@rotorsoft/act-http/api` is what keeps the transports honest:

```ts no-check
import {
  type ActorExtractor,
  type ApiError,
  ERROR_MAP,
  toApiError,
  withIdempotency,
} from "@rotorsoft/act-http/api";
```

### `ActorExtractor`

A type alias for `(request: TRequest) => Actor | Promise<Actor>`, where `TRequest` defaults to `unknown`. The host supplies it; each transport runs it once per call to populate the actor that flows into `app.do(...)`. Each transport types `request` as what it hands over: tRPC as your `Ctx`, Hono as its `Context`, so the extractor reads them without a cast. An extractor that takes `unknown` still plugs into both. The actor type and the "throw to deny" semantics are the same everywhere.

### `ApiError` envelope + `ERROR_MAP` + `toApiError`

The error shape every transport ships:

```ts
type ApiError = {
  error: string;     // framework error name ("ValidationError", "ConcurrencyError", …)
  detail?: string;   // framework's message text — human-readable
  code?: string;     // machine-readable code from ERROR_MAP ("VALIDATION", "CONCURRENCY", …)
};
```

`ERROR_MAP` is an `as const` table from framework error class to `{ status, code }`:

| Error | HTTP status / `code` | tRPC code |
|---|---|---|
| `ValidationError` | 422 / `VALIDATION` | `UNPROCESSABLE_CONTENT` |
| `PreconditionError` | 409 / `PRECONDITION` | `CONFLICT` |
| `InvariantError` (deprecated, from `.given` rules) | 409 / `INVARIANT` | `CONFLICT` |
| `ConcurrencyError` | 412 / `CONCURRENCY` | `PRECONDITION_FAILED` |
| `StreamClosedError` | 410 / `STREAM_CLOSED` | `NOT_FOUND` (404): tRPC has no 410 |
| `NonRetryableError` | 400 / `NON_RETRYABLE` | `BAD_REQUEST` |
| anything else | 500 / `INTERNAL` | `INTERNAL_SERVER_ERROR` |
 The transports never define their own mapping — they all call `toApiError(err)` at their error boundary and forward `{ status, body }` to the wire. Operators wanting different mappings wrap the transport instead of mutating the table; consistency is the load-bearing property, not the specific status codes.

### `withIdempotency`

`withIdempotency(store, key, handler)` wraps an action handler in an `Idempotency-Key` claim. It reuses the `@rotorsoft/act-ops/idempotency` contract — the same `IdempotencyStore` that `@rotorsoft/act-http/receiver` consumes, so one store implementation covers both halves of the "Act over the wire" surface: outbound (this package's generated APIs) and inbound (the receiver's webhook ingestion).

The semantics intentionally don't cache the original handler's result, which avoids the operational footgun of replaying potentially stale responses. A losing claim returns `{ deduped: true }`, but that alone doesn't say whether the original *succeeded* or is *still running*, and the generated routes answer the two differently. A duplicate of a key that already committed gets `409 CONFLICT`. A duplicate that arrives while the original is still running (typically a client that timed out and retried) gets a retryable `503` instead: the original may yet fail and release the key, and a client told "already used" would never retry, so the action would be lost ([#1741](https://github.com/Rotorsoft/act-root/issues/1741)). The receiver answers the same in-flight case with `503` too (#1700).

## Authentication — the `actor` seam

The package deliberately doesn't ship JWT verification, session store integration, or API-key validation. Auth is too varied — every team has its own choice — and bundling a specific implementation would make the package opinionated in the wrong direction.

What the package ships instead is the `ActorExtractor` seam. Plug whatever you already have:

```ts no-check
// JWT bearer
const actor: ActorExtractor = async (ctx) => {
  const token = ctx.req.header("authorization")?.replace(/^Bearer /, "");
  if (!token) throw new Error("missing token");
  const claims = await verifyJwt(token); // your JWT lib of choice
  return { id: claims.sub, name: claims.name };
};

// Session cookie + lookup
const actor: ActorExtractor = async (ctx) => {
  const sessionId = ctx.req.cookie("sid");
  const user = await sessionStore.get(sessionId);
  if (!user) throw new Error("not authenticated");
  return { id: user.id, name: user.email };
};

// API key
const actor: ActorExtractor = (ctx) => {
  const key = ctx.req.header("x-api-key");
  const owner = lookupApiKey(key);
  if (!owner) throw new Error("invalid key");
  return { id: owner.id, name: owner.name };
};
```

Whatever the extractor returns becomes `Target.actor` in every `app.do(...)` call the generator dispatches. The actor flows all the way into the event committed to the store — `events.actor_id` / `events.actor_name` come from this seam, end of trace.

:::warning Never ship a constant actor
Because every generated mutation trusts whatever the extractor returns, a hardcoded resolver — `actor: () => ({ id: "1", name: "Alice" })` — grants every caller the same identity with no authentication. That's a privilege-escalation footgun, not a starting point. The `packages/server` demo isolates its fake resolver in a `resolveDemoActor()` that logs a one-time warning on use and carries a `// DEMO ONLY — no auth` marker precisely so it reads as scaffolding to replace, not to copy. Production hosts **must** resolve a verified actor from a JWT, session, mTLS identity, or API key as shown above.
:::

Errors thrown from the extractor surface as `401 / UNAUTHORIZED` on the Hono adapter and as `UNAUTHORIZED` on the tRPC adapter. Both honor the message text in the `detail` field of the envelope.

### Composing the auth middleware separately

Both `/trpc` and `/hono` also export the underlying `authenticated(extractor)` middleware so you can compose it into your own chain alongside the generated routes:

```ts no-check
// Hono
import { Hono } from "hono";
import { authenticated, type ActMiddlewareVariables } from "@rotorsoft/act-http/hono";

const api = new Hono<{ Variables: ActMiddlewareVariables }>();
api.use("*", authenticated(myExtractor));
api.get("/me", (c) => c.json(c.get("actor"))); // typed, no cast needed

// tRPC
import { authenticated } from "@rotorsoft/act-http/trpc";
const authed = t.procedure.use(authenticated(myExtractor));
// every procedure derived from `authed` sees ctx.actor: Actor
```

This is the right pattern when you want a Hono/tRPC instance with a mix of generated and hand-written routes: the middleware runs once and downstream sees the resolved actor regardless of how the route got registered.

## Optimistic concurrency

Every generator accepts an optional `expectedVersion(action, input, ctx) => number | undefined`. When the callback returns a number, the generator threads it into `Target.expectedVersion` for that call — `app.do` enforces the optimistic-concurrency check and throws `ConcurrencyError` on a stale write. Returning `undefined` leaves the call to the version the action loads; a number pins it, and a pinned conflict is never retried.

The conventional wiring is the `If-Match` header on REST or a last-known-version field on a tRPC input — either way the host owns where the expected version comes from. Document it for both transports in one shot via the OpenAPI emitter's `expectedVersion: true` option, which adds the `If-Match` parameter to every operation.

## Idempotency

Same shape on every transport. The `idempotency` option takes an `IdempotencyStore` from `@rotorsoft/act-ops/idempotency` and an optional `keyFrom(ctx) => string | undefined` extractor:

```ts no-check
import { hono } from "@rotorsoft/act-http/hono";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";

const api = hono(app, {
  actor,
  stream,
  idempotency: {
    store: new InMemoryIdempotencyStore(),
    // Default keyFrom reads the Idempotency-Key header — override only for custom conventions.
  },
});
```

Document the header on the OpenAPI emitter the same way:

```ts no-check
openapi(app, { info, servers, idempotency: true });
```

Behavior: fresh claim → handler runs, response normal. Duplicate of a committed key → `409 CONFLICT` with `code: "CONFLICT"` and `detail: "Idempotency-Key already used; original result not cached"`. Duplicate while the original is still running → `503` with `Retry-After: 1` and `code: "IN_FLIGHT"`. tRPC throws `CONFLICT` and `SERVICE_UNAVAILABLE` respectively (a procedure can't set `Retry-After`). The in-flight check is local to the process serving the generated API, matching `InMemoryIdempotencyStore`'s single-process scope. See the [External integration guide](./external-integration.md) for the surrounding pattern — this is the same `IdempotencyStore` contract that powers receivers.

## Real-time subscriptions

Both `trpc(app, { sse })` and `hono(app, { sse })` accept an optional SSE wiring that walks the registry and emits **one subscription per unique state name**, all reading from a host-supplied `BroadcastChannel`. The host continues to own publication; the generator owns subscription, accounting, cleanup, and the wire format — so the loop you used to hand-write (open SSE response, subscribe to channel, forward patches, manage heartbeat, decrement counter on close) collapses to one option. On tRPC the subscriptions mount at `router.subscribe.<stateName>`, beside the action mutations, so `subscribe` is a reserved action name there: generating a router with `sse` for an app that has an action called `subscribe` throws instead of silently dropping the action ([#1747](https://github.com/Rotorsoft/act-root/issues/1747)).

```ts no-check
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { trpc } from "@rotorsoft/act-http/trpc";
import { hono } from "@rotorsoft/act-http/hono";

const broadcast = new BroadcastChannel<MyState>();

// Server-side: after every app.do(...), publish the derived state.
const snaps = await app.do(action, target, payload);
broadcast.publish(
  target.stream,
  deriveState(snaps),
  snaps.map((s) => s.patch).filter(Boolean)
);

// tRPC — emits one subscription per registered state under
// `router.subscribe.<stateName>`.
const router = trpc(app, {
  actor,
  stream,
  sse: { channel: broadcast },
});
// Client:
//   trpc.subscribe.Ticket.useSubscription({ stream: "ticket-42" })

// Hono — emits one streaming `GET /api/sse/<stateName>?stream=<id>`
// per registered state.
const api = hono(app, {
  actor,
  stream,
  sse: { channel: broadcast },
});
// Client:
//   new EventSource("/api/sse/Ticket?stream=ticket-42")
```

### What the generator owns

For every subscription, on every open:

1. Run the `actor` extractor (`401` / `UNAUTHORIZED` on throw).
2. Acquire one slot on the per-process counter. Full counter →
   - Hono: `503 / SSE_BUSY` with `Retry-After: 1` (header set **before** the response body starts so it's a clean reject, not a hung stream).
   - tRPC: `TRPCError({ code: "TOO_MANY_REQUESTS" })`.
3. Yield `{ kind: "state", data }` once if `channel.state(streamId)` has a cached value (re-connect / cold-start affordance — the client doesn't need a separate `getById` query).
4. Subscribe to the channel for `streamId` and forward every publication as `{ kind: "patch", data }`. The per-connection backlog of undelivered frames is bounded by `maxPendingPerConnection` (default 256): when a slow consumer can't drain as fast as a busy stream publishes, the **oldest** frame is dropped to make room for the newest (drop-oldest). Each frame carries a full version-keyed patch, so the consumer converges on current state even after a skip — it just misses intermediate versions it was too slow to see. This caps per-connection memory independently of the connection-count cap.
5. Run a keep-alive ping every `heartbeatMs` (default 30 s). Below the 60 s idle timeout most reverse proxies impose.
6. Tear down on `iter.return()` / disconnect / abort: unsubscribe, release the slot, clear the heartbeat. The teardown runs from a `finally` block so a crashed handler doesn't leak count. A subscription that could not acquire a slot (cap full, no `on_cap_exceeded` reject) releases nothing on teardown — only an acquired slot is released, so the counter never underflows.

The shared loop is exported as `runSseSubscription` from `@rotorsoft/act-http/api` for adopters who want to build a different transport (WebSocket, a custom long-poll bridge) on the same accounting + cancellation discipline.

### Defaults and validation

`SseOptions = { channel, maxConnections?, heartbeatMs?, maxPendingPerConnection? }`. Defaults sized for typical business-app dashboards:

| Knob | Default | Range | Why |
|---|---|---|---|
| `maxConnections` | `500` | `[1, 10_000]` | Comfortable for hundreds of human viewers; above 10k the FD ceiling and memory force horizontal scaling regardless of tuning. |
| `heartbeatMs` | `30_000` | `[15_000, 300_000]` | Sub-15s wastes bandwidth on business workloads; above 5 min risks proxy idle drops. |
| `maxPendingPerConnection` | `256` | `[1, 100_000]` | Bounds the per-connection undelivered-frame backlog. A stalled consumer on a busy stream can't drain as fast as it publishes; at the bound the oldest frame is dropped (drop-oldest) so one wedged client can't pin unbounded memory. |

Out-of-range knobs throw `ZodError` at transport construction — misconfiguration surfaces at startup, not at first connection. (Every config bag in the framework validates with Zod and throws `ZodError` at its entry point.)

### Why SSE, not WebSocket

Projection patches are one-way (server → client) and rebuildable from the event log — exactly the workload SSE was designed for. SSE rides plain HTTP, traverses corporate proxies cleanly, auto-reconnects on disconnect, needs no protocol upgrade. WebSocket would buy duplex we don't use; long-polling would burn round-trips. The `BroadcastChannel` primitive at `@rotorsoft/act-http/sse` was already shipping this contract — the new generator wiring just lifts it into the auto-generated transport.

### Horizontal scaling

SSE doesn't multiplex across processes. Each worker enforces its own `maxConnections` cap. For deployments where active viewers exceed the per-process ceiling, operators run multiple processes behind a **sticky** load balancer (one subscriber per process, no failover for an open connection) and let the channel publication run per-worker as well. There is no cross-process channel; the `BroadcastChannel` is in-memory.

## Deployment recipes

The three generators were designed to run on every fetch-shaped runtime. Pick the recipe that matches your shape.

### Node + Hono

The default shape used in `packages/server`:

```ts no-check
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

const root = new Hono();
root.use("*", cors({ origin: process.env.CORS_ORIGIN }));

// Mount the REST surface.
root.route("/", restApi);

// Bridge tRPC over fetch — Hono's c.req.raw is already a Request.
root.all("/trpc/*", (c) =>
  fetchRequestHandler({ endpoint: "/trpc", req: c.req.raw, router: tRouter })
);

// Serve the OpenAPI document and a Scalar UI.
root.get("/openapi.json", (c) => c.json(doc));
root.get("/docs", (c) => c.html(SCALAR_PAGE));

serve({ fetch: root.fetch, port: 4000 });
```

The `fetchRequestHandler` from `@trpc/server/adapters/fetch` is the right tRPC adapter for fetch-shaped runtimes. It speaks `Request`/`Response` natively — which is what Hono's `c.req.raw` already produces — so no Node `IncomingMessage`/`ServerResponse` shim is needed. The standalone adapter (`createHTTPHandler`) is Node-only and requires the shim; if you're already on Hono, prefer the fetch adapter.

### Vercel / AWS Lambda / Cloudflare Workers

Hono's `app.fetch` is the entrypoint every edge runtime expects:

```ts no-check
// Vercel
export default { fetch: app.fetch };

// AWS Lambda (via the Hono node adapter for Lambda)
export const handler = handle(app);

// Cloudflare Workers
export default { fetch: app.fetch };
```

The generator emits a vanilla Hono app — nothing in `hono(app, ...)` ties it to Node. If you wire `idempotency`, swap the in-memory store for a distributed one (Redis, Workers KV, DynamoDB) so dedup survives across worker instances.

### tRPC inside Next.js or a Vite SPA

A typed React client needs only the router's type. Export `typeof router` from a shared workspace package; the server mounts the runtime router (under Next.js's `api/trpc/[trpc]` route or a Vite or Express server), and the client imports only the type and feeds it to `createTRPCReact<typeof router>()`. In this repo `packages/server` generates the router and the Hono app, exports their types (`AppRouter`, `Api`), and mounts both beside the OpenAPI document; `packages/client` imports those types only.

## Event versioning surfaces in the API

Act's `_v<n>` convention (see [Event schema evolution](../architecture/event-schema-evolution.md)) is invisible to the generated transports — and that's the point.

The generator emits one HTTP-level action per registered action. Actions don't have versions; events do. When you add `OrderConfirmed_v2` next to `OrderConfirmed`, the registry gains a new event the reducer learns to handle and the dispatcher knows to emit going forward; the action that triggers it (`ConfirmOrder`) stays the same.

The OpenAPI document reflects the action surface, which is stable across event-version bumps. Reducers can absorb `_v1` history while emitters move to `_v2` without an API-surface change. Clients are unaffected.

## Migrating from a hand-written router

The pattern: replace the manual router with `trpc(app, options)` or `hono(app, options)` and check whether the client still type-checks.

```ts no-check
// Before — hand-written tRPC router
export const router = t.router({
  OpenTicket: t.procedure
    .input(Tickets.actions.OpenTicket)
    .mutation(async ({ input, ctx }) => {
      const actor = ctx.user;
      return app.do("OpenTicket", { stream: `ticket-${ctx.tenantId}`, actor }, input);
    }),
  ResolveTicket: t.procedure
    .input(Tickets.actions.ResolveTicket)
    .mutation(/* same shape */)
  // …
});

// After
import { trpc } from "@rotorsoft/act-http/trpc";

type Ctx = { user: { id: string; name: string }; tenantId: string };

export const router = trpc<Ctx, typeof app>(app, {
  actor: (ctx) => ctx.user,
  stream: (action, input, ctx) => `ticket-${ctx.tenantId}`,
});
```

The client keeps its types: `createTRPCReact<typeof router>()` sees the same procedures, inputs and outputs the hand-written router declared. `packages/server` generates its tRPC router and REST routes this way, and `packages/client` types itself from them.

## Pointers

- `libs/act-http/src/trpc/index.ts`, `libs/act-http/src/hono/index.ts`, `libs/act-http/src/openapi/index.ts` — the three generators
- `libs/act-http/src/api/` — `ActorExtractor`, `ApiError`, `ERROR_MAP`, `toApiError`, `withIdempotency`
- `libs/act-http/README.md` — full API reference for every option
- `packages/server/src/server.ts` — multi-transport demo wiring all three generators against the same Act
- `packages/server/src/api.ts` — the calculator's generated tRPC router and REST routes, exported as types for the client
- [External integration patterns](./external-integration.md) — the inbound-webhook side of the same `IdempotencyStore` contract
- [Event schema evolution](../architecture/event-schema-evolution.md) — what stays stable across `_v<n>` bumps
