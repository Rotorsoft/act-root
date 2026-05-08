# server

A minimal tRPC HTTP server that hosts the calculator router from `@act/calculator`. Pairs with `@act/client` to demonstrate end-to-end Act → tRPC → React.

> Workspace package, not published. Run via `pnpm dev:trpc` from the monorepo root (which boots both server and client).

## What it does

- Imports `calculatorRouter` from `@act/calculator` — Zod schemas from the Calculator state are reused as tRPC input validators
- Wraps it with the standalone tRPC HTTP adapter
- Adds CORS so the Vite client (different origin) can call it
- Listens on port `4000`

That's it — twelve lines of glue. The interesting code lives in [`@act/calculator`](../calculator).

## Quickstart

```bash
# From the monorepo root — runs server (4000) and client (3000) concurrently
pnpm dev:trpc

# Or just the server
pnpm -F server dev
```

`dev` runs `tsx watch src/server.ts`, so edits to the calculator package or the server itself reload automatically.

## Source

```ts
// src/server.ts
import { calculatorRouter } from "@act/calculator";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";

const server = createHTTPServer({
  middleware: cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
  }),
  router: calculatorRouter,
});
server.listen(4000, () => {});
```

## Configuration

| Env var       | Default                  | Purpose                          |
|---------------|--------------------------|----------------------------------|
| `CORS_ORIGIN` | `http://localhost:5173`  | Allowed origin for CORS requests |

The root `pnpm dev:trpc` script sets `CORS_ORIGIN=http://localhost:3000` for you (matching the Vite client in `packages/client/vite.config.ts`). When running `pnpm -F server dev` standalone against a client on a different origin, set `CORS_ORIGIN` accordingly.

## Procedures

Inherited from `calculatorRouter`:

| Procedure   | Type     | Input                          | Effect                              |
|-------------|----------|--------------------------------|-------------------------------------|
| `PressKey`  | mutation | `{ key: digit \| operator \| symbol }` | Dispatches `PressKey` to stream `calculator` |
| `Clear`     | mutation | none                           | Dispatches `Clear` to stream `calculator`    |

The router is exported as `CalculatorRouter` and consumed by `@act/client` to build a fully type-safe tRPC client — no schema duplication.

## Switching to PostgreSQL

The router (in `@act/calculator/src/router.ts`) builds its `act()` app with the default `InMemoryStore`. For a persistent server, inject a `PostgresStore` before importing the router, e.g. in a small bootstrap module:

```ts
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({ schema: "act", table: "calculator" }));

// then…
import { calculatorRouter } from "@act/calculator";
```

`store()` is a singleton accessor — set it once at startup and the router's app picks it up.

## Related

- [`@act/calculator`](../calculator) — defines `calculatorRouter` and the underlying state machine
- [`@act/client`](../client) — React + tRPC client that calls `PressKey` / `Clear`
- [tRPC standalone adapter docs](https://trpc.io/docs/server/adapters/standalone)
