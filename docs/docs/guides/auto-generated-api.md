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
| Optional idempotency | Claim an `Idempotency-Key`; ack the duplicate | Identical |

Five of those six rows are identical across transports. The remaining row — resolving actor and stream — gets parameterized as two functions that the host supplies. Everything else is one mechanical loop over `app.registry.actions`.

That's all the generators do. There's no codegen step, no schema generator, no second source file to keep in sync. The Zod schemas you already wrote against your actions and events drive the wire format directly.

## Quick start — one Act, three transports

The shape that lands in the multi-transport demo (`packages/server` in this repo):

```ts
import { act } from "@rotorsoft/act";
import { hono } from "@rotorsoft/act-http/hono";
import { openapi } from "@rotorsoft/act-http/openapi";
import { trpc } from "@rotorsoft/act-http/trpc";
import { Calculator } from "./calculator.js";

// 1. Build the Act registry. This is your application, untouched by transport concerns.
const app = act().withState(Calculator).build();

// 2. Generate a tRPC router. Use `typeof tRouter` for a typed client.
const tRouter = trpc(app, {
  actor: (ctx) => resolveActorFromJwt(ctx),
  stream: (action, input, ctx) => `tenant-${ctx.tenant}`,
});

// 3. Generate a Hono REST surface. POST /api/actions/<action> per registered action.
const restApi = hono(app, {
  actor: (c) => resolveActorFromJwt(c),
  stream: (action, input, c) => `tenant-${c.req.header("x-tenant")}`,
});

// 4. Emit an OpenAPI 3.1 document describing the REST surface.
const doc = openapi(app, {
  info: { title: "Calculator API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
});
```

That's it — three transports against one registry. Add an action to the Calculator and all three pick it up on next build.

## The three subpaths

### `@rotorsoft/act-http/trpc`

The generator emits a flat router — one mutation per registered action, keyed by the action name:

```ts
const router = trpc(app, {
  actor: (ctx) => ({ id: ctx.user.id, name: ctx.user.name }),
  stream: (action, input, ctx) => `tenant-${ctx.tenant}`,
  expectedVersion: (action, input, ctx) => readIfMatchHeader(ctx),
});

// Client side, no codegen:
await client.OpenTicket.mutate({ title: "support" });
```

The router is **flat by design**. State-name grouping (e.g. `client.Tickets.OpenTicket`) was considered and dropped — action names are unique across a registry (the framework enforces no duplicates at build), and the extra nesting was overhead that bought nothing.

Errors map through `toApiError(...)` from `@rotorsoft/act-http/api` to the conventional tRPC codes: `ConcurrencyError → CONFLICT`, `InvariantError → CONFLICT`, `ValidationError → UNPROCESSABLE_CONTENT`, `StreamClosedError → PRECONDITION_FAILED`, `NonRetryableError → BAD_REQUEST`, anything else → `INTERNAL_SERVER_ERROR`.

#### One caveat to know about

tRPC v11's `BuiltRouter` type transitively references an internal `Unwrap` symbol from `@trpc/server/dist/unstable-core-do-not-import`. TypeScript's `--declaration` emitter can't name that symbol portably for the generator's `<TApp>`-parameterized return, which means a consumer doing `createTRPCReact<typeof generatedRouter>()` trips the React-tRPC name-collision check (it sees an over-wide procedure record and complains that procedures like `Provider` or `useContext` clash with built-ins).

In practice that means: the generator is fully usable for **server-only** mounts via `createHTTPHandler` or `fetchRequestHandler`, but if your client wants `createTRPCReact<typeof router>()` end-to-end type sharing, hand-write the small handful of procedures in the calculator-router shape. The hand-written form is short for any concrete registry and the `@rotorsoft/act-http/trpc` test suite continues to exercise the generator. The follow-up is gated on tRPC v11 exposing a portable `BuiltRouter` substitute or this repo enabling `isolatedDeclarations`.

The wolfdesk and calculator examples each take a different side of this trade-off; both work.

### `@rotorsoft/act-http/hono`

Same registry, same options shape, REST instead of RPC:

```ts
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
```

The generator registers one `POST /actions/<actionName>` per action under `basePath` (default `/api`). `@hono/zod-validator` runs each action's registered Zod schema against the request body; failures short-circuit with `400`. Errors map through `toApiError` to `412 / CONCURRENCY`, `409 / INVARIANT`, `422 / VALIDATION`, `410 / STREAM_CLOSED`, `400 / NON_RETRYABLE`, and `500 / INTERNAL` for unknown throws.

Edge-runtime ready — Hono runs unchanged on Node, Bun, Cloudflare Workers, Vercel Edge, AWS Lambda, Deno. If you wire `idempotency`, verify the `IdempotencyStore` is edge-compatible: in-memory works per worker, cross-worker requires a distributed store.

### `@rotorsoft/act-http/openapi`

A pure-data emitter — no runtime dep on Hono or tRPC. Returns an OpenAPI 3.1 document object you can serialize and serve, or pass to a docs renderer:

```ts
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

A clean way to serve the doc plus an interactive explorer in one shot — Scalar reads the live document from the same server:

```ts
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

```ts
import {
  type ActorExtractor,
  type ApiError,
  ERROR_MAP,
  toApiError,
  withIdempotency,
} from "@rotorsoft/act-http/api";
```

### `ActorExtractor`

A type alias for `(request: unknown) => Actor | Promise<Actor>`. The host supplies it; each transport runs it once per call to populate the actor that flows into `app.do(...)`. The transports differ only in what `request` is (a tRPC `ctx`, a Hono `Context`) — the actor type, the signature shape, and the "throw to deny" semantics are identical.

### `ApiError` envelope + `ERROR_MAP` + `toApiError`

The error shape every transport ships:

```ts
type ApiError = {
  error: string;     // framework error name ("ValidationError", "ConcurrencyError", …)
  detail?: string;   // framework's message text — human-readable
  code?: string;     // machine-readable code from ERROR_MAP ("VALIDATION", "CONCURRENCY", …)
};
```

`ERROR_MAP` is an `as const` table from framework error class to `{ status, code }`. The transports never define their own mapping — they all call `toApiError(err)` at their error boundary and forward `{ status, body }` to the wire. Operators wanting different mappings wrap the transport instead of mutating the table; consistency is the load-bearing property, not the specific status codes.

### `withIdempotency`

`withIdempotency(store, key, handler)` wraps an action handler in an `Idempotency-Key` claim. It reuses the `@rotorsoft/act-ops/idempotency` contract — the same `IdempotencyStore` that `@rotorsoft/act-http/receiver` consumes, so one store implementation covers both halves of the "Act over the wire" surface: outbound (this package's generated APIs) and inbound (the receiver's webhook ingestion).

The semantics intentionally don't cache the original handler's result. A duplicate claim throws / returns a `409 CONFLICT` with `{ deduped: true }`. The contract matches the receiver-side "ack the duplicate" pattern and avoids the operational footgun of replaying potentially-stale responses.

## Authentication — the `actor` seam

The package deliberately doesn't ship JWT verification, session store integration, or API-key validation. Auth is too varied — every team has its own choice — and bundling a specific implementation would make the package opinionated in the wrong direction.

What the package ships instead is the `ActorExtractor` seam. Plug whatever you already have:

```ts
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

Errors thrown from the extractor surface as `401 / UNAUTHORIZED` on the Hono adapter and as `UNAUTHORIZED` on the tRPC adapter. Both honor the message text in the `detail` field of the envelope.

### Composing the auth middleware separately

Both `/trpc` and `/hono` also export the underlying `authenticated(extractor)` middleware so you can compose it into your own chain alongside the generated routes:

```ts
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

Every generator accepts an optional `expectedVersion(action, input, ctx) => number | undefined`. When the callback returns a number, the generator threads it into `Target.expectedVersion` for that call — `app.do` enforces the optimistic-concurrency check and throws `ConcurrencyError` on a stale write. Returning `undefined` skips the check for that call.

The conventional wiring is the `If-Match` header on REST or a last-known-version field on a tRPC input — either way the host owns where the expected version comes from. Document it for both transports in one shot via the OpenAPI emitter's `expectedVersion: true` option, which adds the `If-Match` parameter to every operation.

## Idempotency

Same shape on every transport. The `idempotency` option takes an `IdempotencyStore` from `@rotorsoft/act-ops/idempotency` and an optional `keyFrom(ctx) => string | undefined` extractor:

```ts
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

```ts
openapi(app, { info, servers, idempotency: true });
```

Behavior: fresh claim → handler runs, response normal. Duplicate claim → `409 CONFLICT` with `code: "CONFLICT"` and `detail: "Idempotency-Key already used; original result not cached"`. Same shape on tRPC (the procedure throws `CONFLICT`). See the [External integration guide](./external-integration.md) for the surrounding pattern — this is the same `IdempotencyStore` contract that powers receivers.

## Deployment recipes

The three generators were designed to run on every fetch-shaped runtime. Pick the recipe that matches your shape.

### Node + Hono

The default shape used in `packages/server`:

```ts
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

```ts
// Vercel
export default { fetch: app.fetch };

// AWS Lambda (via the Hono node adapter for Lambda)
export const handler = handle(app);

// Cloudflare Workers
export default { fetch: app.fetch };
```

The generator emits a vanilla Hono app — nothing in `hono(app, ...)` ties it to Node. If you wire `idempotency`, swap the in-memory store for a distributed one (Redis, Workers KV, DynamoDB) so dedup survives across worker instances.

### tRPC inside Next.js or a Vite SPA

When the tRPC router is consumed by a typed React client (`createTRPCReact<typeof router>()`), the hand-written-router caveat above applies. The pattern that works today:

- Define the hand-written router in a shared workspace package (e.g. `@app/calculator`), exporting both the runtime router and `typeof router` as `CalculatorRouter`.
- The server package imports the runtime router and mounts it (under Next.js's `api/trpc/[trpc]` route or a Vite/Express server).
- The client imports only the type and feeds it to `createTRPCReact<CalculatorRouter>()`.

`packages/calculator` and `packages/client` in this repo demonstrate the pattern; the multi-transport `packages/server` mounts the calculator's tRPC router alongside the generated Hono REST + OpenAPI.

## Event versioning surfaces in the API

Act's `_v<n>` convention (see [Event schema evolution](../architecture/event-schema-evolution.md)) is invisible to the generated transports — and that's the point.

The generator emits one HTTP-level action per registered action. Actions don't have versions; events do. When you add `OrderConfirmed_v2` next to `OrderConfirmed`, the registry gains a new event the reducer learns to handle and the dispatcher knows to emit going forward; the action that triggers it (`ConfirmOrder`) stays the same.

The OpenAPI document reflects the action surface, which is stable across event-version bumps. Reducers can absorb `_v1` history while emitters move to `_v2` without an API-surface change. Clients are unaffected.

## Migrating from a hand-written router

The pattern: replace the manual router with `trpc(app, options)` or `hono(app, options)` and check whether the client still type-checks.

```ts
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

export const router = trpc(app, {
  actor: (ctx) => ctx.user,
  stream: (action, input, ctx) => `ticket-${ctx.tenantId}`,
});
```

If `createTRPCReact<typeof router>()` still works (or you're consuming the router server-side only), you're done. If it doesn't and you can't move past the tRPC typing caveat above, keep the hand-written tRPC router and still use the generator for the Hono REST + OpenAPI surfaces — that's the split `packages/calculator` + `packages/server` demonstrates in this repo. One source of truth for the registry, one source of truth for the routes that can be generated, the small remainder explicit.

## Pointers

- `libs/act-http/src/trpc/index.ts`, `libs/act-http/src/hono/index.ts`, `libs/act-http/src/openapi/index.ts` — the three generators
- `libs/act-http/src/api/` — `ActorExtractor`, `ApiError`, `ERROR_MAP`, `toApiError`, `withIdempotency`
- `libs/act-http/README.md` — full API reference for every option
- `packages/server/src/server.ts` — multi-transport demo wiring all three generators against the same Act
- `packages/calculator/src/router.ts` — hand-written tRPC router for the typed client side
- [External integration patterns](./external-integration.md) — the inbound-webhook side of the same `IdempotencyStore` contract
- [Event schema evolution](../architecture/event-schema-evolution.md) — what stays stable across `_v<n>` bumps
