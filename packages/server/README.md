# @act/server

A multi-transport HTTP server that mounts **every** `@rotorsoft/act-http` transport against the same `calculatorApp` from `@act/calculator` — tRPC, Hono REST, and a live OpenAPI document, all on one port.

> Workspace package, not published. Run via `pnpm dev:http` from the monorepo root (which boots both server and client).

## What it does

One Act instance, three transports mounted side-by-side on a single Hono root app:

| URL                                    | Source                                       | Use                                          |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `POST /trpc/PressKey`, `/trpc/Clear`   | Hand-written `t.router({...})` in `@act/calculator` | Typed tRPC React client at :3000             |
| `POST /api/actions/PressKey`, `/Clear` | `hono(calculatorApp, ...)` from `@rotorsoft/act-http/hono` | Plain-fetch REST clients, Vite toggle's REST mode |
| `GET  /openapi.json`                   | `openapi(calculatorApp, ...)` from `@rotorsoft/act-http/openapi` | Swagger / RapiDoc / Redoc                    |
| `GET  /`                               | Hand-rolled landing page                     | Operator orientation                         |

The Vite client (`packages/client`) gains a transport toggle that swaps between the tRPC mutations and the REST routes, exercising both surfaces against the same stream.

## Quickstart

```bash
# From the monorepo root — runs server (4000) and client (3000) concurrently
pnpm dev:http

# Or just the server
pnpm -F server dev
```

`dev` runs `tsx watch src/server.ts`, so edits to the calculator package or the server itself reload automatically. Open `http://localhost:4000/` for the landing page, or `http://localhost:3000/` for the client UI.

## Configuration

| Env var       | Default                  | Purpose                          |
|---------------|--------------------------|----------------------------------|
| `CORS_ORIGIN` | `http://localhost:5173`  | Allowed origin for CORS requests |

The root `pnpm dev:http` script sets `CORS_ORIGIN=http://localhost:3000` for you (matching the Vite client in `packages/client/vite.config.ts`). When running `pnpm -F server dev` standalone against a client on a different origin, set `CORS_ORIGIN` accordingly.

## Why hand-written tRPC router

The Hono and OpenAPI generators are used as designed (`hono(calculatorApp, ...)` / `openapi(calculatorApp, ...)`). The tRPC sibling at `@rotorsoft/act-http/trpc` is *not* used here, on purpose: tRPC v11's `BuiltRouter` transitively references the internal `Unwrap` symbol from `@trpc/server/dist/unstable-core-do-not-import`, which the d.ts emitter can't name portably for the generator's `<TApp>` return — and the same shape downstream trips `createTRPCReact<typeof router>()`'s collision check. For two static actions and a fixed actor the hand-written router is shorter than every workaround, and is preserved in `@act/calculator` so the client can use `typeof calculatorRouter` for end-to-end type safety. The generator stays available for server-only mounts via `createHTTPHandler`.

## Switching to PostgreSQL

The router (in `@act/calculator/src/router.ts`) builds its `act()` app with the default `InMemoryStore`. For a persistent server, inject a `PostgresStore` before importing the router, e.g. in a small bootstrap module:

```ts
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({ schema: "act", table: "calculator" }));

// then…
import { calculatorRouter, calculatorApp } from "@act/calculator";
```

`store()` is a singleton accessor — set it once at startup and both the router and the `calculatorApp` (which `hono(...)` / `openapi(...)` walk) pick it up.

## Related

- [`@act/calculator`](../calculator) — defines `calculatorApp`, `calculatorRouter`, and the underlying state machine
- [`@act/client`](../client) — React + tRPC client with REST-toggle and OpenAPI link
- [`@rotorsoft/act-http`](../../libs/act-http) — the trpc / hono / openapi subpaths
