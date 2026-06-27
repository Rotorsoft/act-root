# @act/client

A minimal React + Vite client for the calculator example. Demonstrates how to call an Act-backed tRPC router from a browser with full end-to-end type safety **and** how to swap to the generated Hono REST surface with one toggle — both transports walking the same Act registry on the server.

> Workspace package, not published. Run via `pnpm dev:http` from the monorepo root (boots both server and client).

## What it does

- Renders a 4×5 calculator keypad with a **transport toggle** (tRPC ↔ REST) and a link to the live `/openapi.json`
- In tRPC mode: calls `PressKey` / `Clear` mutations on the server-hosted `calculatorRouter`
- In REST mode: `POST`s to `/api/actions/PressKey` / `/api/actions/Clear` against the same server
- Displays the latest snapshot returned from each mutation (`{ left, operator, right }`)
- Reuses **types from the calculator package** (`Digits`, `Operators`, `CalculatorRouter`) — no duplicated schemas, no codegen

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
│   ├── Calculator.tsx     # Keypad UI + useMutation hooks
│   ├── trpc.ts            # createTRPCReact<CalculatorRouter>() + httpLink
│   ├── App.css, index.css # Styles
│   └── assets/            # Static assets
└── public/                # Public assets (favicon, etc.)
```

## How the type chain works

1. **Calculator state** (`@act/calculator/src/calculator.ts`) defines actions and events using Zod schemas
2. **Router** (`@act/calculator/src/router.ts`) wraps those Zod schemas as tRPC procedures and exports `CalculatorRouter`
3. **Server** (`@act/server`) hosts that router on `http://localhost:4000`
4. **Client** imports `CalculatorRouter` as a type and feeds it to `createTRPCReact<CalculatorRouter>()`:

```ts
// src/trpc.ts
import type { CalculatorRouter } from "@act/calculator";
import { createTRPCReact, httpLink } from "@trpc/react-query";

export const trpc = createTRPCReact<CalculatorRouter>();
export const queryClient = new QueryClient({});
export const client = trpc.createClient({
  links: [httpLink({ url: "http://localhost:4000" })],
});
```

5. The component uses fully-typed mutation hooks:

```tsx
// src/Calculator.tsx
import type { Digits, Operators } from "@act/calculator";

const pressKey = trpc.PressKey.useMutation({
  onSuccess: ([snap]) => {
    setDisplay(`${snap.state.left ?? "0"} ${snap.state.operator ?? ""} ${snap.state.right ?? ""}`);
  },
});

const clear = trpc.Clear.useMutation({
  onSuccess: () => setDisplay("0"),
});

// inside the keypad map:
pressKey.mutate({ key: key as Digits | Operators });
```

`snap.state` is typed by the Zod state schema all the way through — change the calculator's state shape in `@act/calculator` and TypeScript will flag mismatches in the client immediately, no codegen step.

## Notes

- All mutations target the single shared stream `calculator` (configured in the router). The UI shows the latest snapshot rather than tracking per-user streams.
- React Query is wired with the default `QueryClient` — no caching strategy beyond the defaults.
- Devtools are installed (`@tanstack/react-query-devtools`) but not mounted by default.

## Related

- [`@act/calculator`](../calculator) — defines the state machine, router, and exported types
- [`@act/server`](../server) — tRPC HTTP server the client connects to
- [tRPC + React Query docs](https://trpc.io/docs/client/react)
