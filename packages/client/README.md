# @act/client

A minimal React + Vite client for the calculator example. Demonstrates how to call an Act-backed tRPC router from a browser with full end-to-end type safety **and** how to swap to the generated Hono REST surface with one toggle — both transports walking the same Act registry on the server.

> Workspace package, not published. Run via `pnpm dev:http` from the monorepo root (boots both server and client).

## What it does

- Renders a 4×5 calculator keypad with a **transport toggle** (tRPC ↔ REST) and a link to the live `/openapi.json`
- In tRPC mode: calls the generated `PressKey` / `Clear` mutations on the server
- In REST mode: calls `/api/actions/PressKey` / `/api/actions/Clear` on the same server through Hono's typed `hc<Api>` client
- Displays the latest snapshot returned from each mutation (`{ left, operator, right }`)
- Shows a **live SSE panel** under the keypad, fed by the generated `subscribe.Calculator` tRPC subscription: the cached state on open, then each patch applied with `applyPatchMessage` from `@rotorsoft/act-http/sse` — state updates on every commit without refetching, from either transport or another tab
- Imports **types only** from the server (`AppRouter`, `Api`, `LiveState`) and the calculator (`Keys`) — no duplicated schemas, no codegen, no casts

## Quickstart

```bash
# From the monorepo root — runs server (4000) and client (3000) concurrently
pnpm dev:http

# Or just the client
pnpm -F client dev
```

The Vite dev server listens on port `3000` (`vite.config.ts`). Open [http://localhost:3000](http://localhost:3000).

The client expects the server at `http://localhost:4000` (hard-coded as `SERVER_BASE` in `src/trpc.ts`, reused by `src/restClient.ts`). The root `dev:http` script sets the matching `CORS_ORIGIN` on the server automatically — when running the server standalone, set `CORS_ORIGIN=http://localhost:3000` yourself.

## Layout

```
packages/client/
├── index.html             # Vite entry HTML
├── vite.config.ts         # port 3000, react plugin
├── src/
│   ├── main.tsx           # Mounts <App />
│   ├── App.tsx            # Wraps Calculator in trpc.Provider + QueryClientProvider
│   ├── Calculator.tsx     # Keypad UI + useMutation hooks + SSE live panel
│   ├── trpc.ts            # createTRPCReact<AppRouter>() + links (SSE for subscriptions)
│   ├── restClient.ts      # hc<Api>() for the REST routes
│   ├── App.css, index.css # Styles
│   └── assets/            # Static assets
└── public/                # Public assets (favicon, etc.)
```

## How the type chain works

1. **Calculator state** (`@act/calculator`) defines actions and events with Zod schemas.
2. **Server** (`@act/server`, `src/api.ts`) generates the tRPC router and the REST routes from the app, and exports their types the tRPC way:

```ts
export const router = trpc(calculatorApp, { actor, stream, sse });
export const api = hono(calculatorApp, { actor, stream, sse });
export type AppRouter = typeof router;
export type Api = typeof api;
```

3. **Client** imports those types and nothing else from the server:

```ts
// src/trpc.ts
import type { AppRouter } from "@act/server";
export const trpc = createTRPCReact<AppRouter>();

// src/restClient.ts
import type { Api } from "@act/server";
export const rest = hc<Api>("http://localhost:4000");
```

4. **The component** writes no types for the API:

```tsx
const pressKey = trpc.PressKey.useMutation({
  onSuccess: ([snap]) => setDisplay(format(snap.state)), // snap.state typed
});
pressKey.mutate({ key });                                  // key: Keys

const res = await rest.api.actions.PressKey.$post({ json: { key } });
if (res.ok) show(await res.json());                        // typed snapshots

trpc.subscribe.Calculator.useSubscription({ stream: "calculator" }, {
  onData: (frame) => { /* frame.data typed: state or patch */ },
});
```

Change the calculator's actions or state shape and TypeScript flags every mismatch in the client, with no codegen step.

## Notes

- All mutations target the single shared stream `calculator` (configured in the router). The UI shows the latest snapshot rather than tracking per-user streams.
- React Query is wired with the default `QueryClient` — no caching strategy beyond the defaults.

## Related

- [`@act/calculator`](../calculator) — the state machine and `Keys`
- [`@act/server`](../server) — the server the client connects to, and the API types it imports
- [tRPC + React Query docs](https://trpc.io/docs/client/react)
