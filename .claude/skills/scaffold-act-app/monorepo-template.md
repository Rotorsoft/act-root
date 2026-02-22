# Monorepo Template

Complete workspace configuration files for scaffolding a new Act application.
Two packages: `domain` (pure logic) and `app` (server + client).

## pnpm-workspace.yaml

```yaml
packages:
  - packages/*
```

## Root package.json

```json
{
  "name": "my-app",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18.0", "pnpm": ">=10.27.0" },
  "packageManager": "pnpm@10.29.3",
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "typecheck": "npx tsc --noEmit --project tsconfig.json",
    "dev": "pnpm -F @my-app/app dev:api & pnpm -F @my-app/app dev:client",
    "start": "pnpm -F @my-app/app start"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^4.0.18",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

> **Dev script**: Run API and Vite client as separate processes with `&`. The app package has `dev:api` (tsx watch) and `dev:client` (vite --host) scripts.

## tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "types": ["node", "vitest/globals"]
  }
}
```

## vitest.config.ts

```typescript
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**/*.ts"],
    },
  },
});
```

## Domain package — packages/domain/package.json

```json
{
  "name": "@my-app/domain",
  "type": "module",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "dependencies": {
    "@rotorsoft/act": "^0.15.0",
    "zod": "^4.3.6"
  }
}
```

## Domain tsconfig — packages/domain/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*", "test/**/*"]
}
```

## App package — packages/app/package.json

```json
{
  "name": "@my-app/app",
  "type": "module",
  "version": "0.0.1",
  "scripts": {
    "dev": "tsx watch src/dev-server.ts",
    "dev:api": "tsx watch src/dev-server.ts",
    "dev:client": "vite --host",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@my-app/domain": "workspace:*",
    "@rotorsoft/act": "^0.15.0",
    "@tanstack/react-query": "^5.90.21",
    "@trpc/client": "11.10.0",
    "@trpc/react-query": "11.10.0",
    "@trpc/server": "11.10.0",
    "cors": "^2.8.6",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/cors": "^2.8.19",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.4",
    "typescript": "~5.9.3",
    "vite": "^7.3.1"
  }
}
```

## App tsconfig — packages/app/tsconfig.json

References separate configs for client and server:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.server.json" }
  ]
}
```

## App tsconfig.app.json (client + API — bundler resolution, no emit)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/client", "src/api"]
}
```

## App tsconfig.server.json (server + API — emits JS)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "strict": true,
    "esModuleInterop": true,
    "declaration": false
  },
  "include": ["src/server.ts", "src/api"]
}
```

## App vite.config.ts

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
});
```

## App index.html (at packages/app/ root)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

## API layer — decomposed tRPC router

### packages/app/src/api/trpc.ts (init + middleware)

```typescript
import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";

export const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.actor) throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

const isAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.actor) throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  if (ctx.actor.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

export const publicProcedure = t.procedure;
export const authedProcedure = t.procedure.use(isAuthenticated);
export const adminProcedure = t.procedure.use(isAdmin);
```

### packages/app/src/api/context.ts (request context + auth)

```typescript
import { getUserByEmail, type AppActor } from "@my-app/domain";
import { verifyToken } from "./auth.js";

export type Context = { actor: AppActor | null };

export function createContext({ req }: { req: { headers: Record<string, string | string[] | undefined> } }): Context {
  const auth = req.headers["authorization"];
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = getUserByEmail(payload.email);
      if (user) return { actor: { id: user.email, name: user.name, picture: user.picture, role: user.role } };
    }
  }
  return { actor: null };
}
```

### packages/app/src/api/auth.ts (token + password crypto)

```typescript
import { createHmac, timingSafeEqual, scryptSync, randomBytes } from "node:crypto";

const SECRET = process.env.SESSION_SECRET || crypto.randomUUID();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function signToken(payload: { email: string }): string {
  const data = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const json = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(json).digest("base64url");
  return `${json}.${sig}`;
}

export function verifyToken(token: string): { email: string } | null {
  const [json, sig] = token.split(".");
  if (!json || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(json).digest("base64url");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  const data = JSON.parse(Buffer.from(json, "base64url").toString());
  if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
  return { email: data.email };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const attempt = scryptSync(password, salt, 64).toString("hex");
  try { return timingSafeEqual(Buffer.from(hash), Buffer.from(attempt)); }
  catch { return false; }
}
```

### packages/app/src/api/helpers.ts (event serialization)

```typescript
export type SerializedEvent = {
  id: number;
  name: string;
  data: Record<string, unknown>;
  stream: string;
  version: number;
  created: string;
  meta: { correlation: string; causation: { action?: unknown; event?: unknown } };
};

export function serializeEvents(events: Array<{ id: number; name: unknown; data: unknown; stream: string; version: number; created: Date; meta: unknown }>): SerializedEvent[] {
  return events.map((e) => ({
    id: e.id,
    name: e.name as string,
    data: e.data as Record<string, unknown>,
    stream: e.stream,
    version: e.version,
    created: e.created.toISOString(),
    meta: e.meta as SerializedEvent["meta"],
  }));
}
```

### packages/app/src/api/domain.routes.ts (domain commands + queries)

```typescript
import { app, getItems } from "@my-app/domain";
import { z } from "zod";
import { t, authedProcedure, adminProcedure, publicProcedure } from "./trpc.js";

export const domainRouter = t.router({
  CreateItem: authedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const target = { stream: crypto.randomUUID(), actor: ctx.actor };
      await app.do("CreateItem", target, input);
      app.settle();  // non-blocking — UI notified via "settled" event after reactions complete
      return { success: true, id: target.stream };
    }),

  getItems: publicProcedure.query(() => getItems()),
});
```

### packages/app/src/api/events.routes.ts (SSE subscription)

```typescript
import { app } from "@my-app/domain";
import { tracked } from "@trpc/server";
import { serializeEvents } from "./helpers.js";
import { t, publicProcedure } from "./trpc.js";

export const eventsRouter = t.router({
  onEvent: publicProcedure.subscription(async function*({ signal }) {
    const existing = await app.query_array({ after: -1 });
    for (const e of serializeEvents(existing)) {
      yield tracked(String(e.id), e);
    }

    let lastId = existing.length > 0 ? existing[existing.length - 1].id : -1;
    let notify: (() => void) | null = null;
    const onSettled = () => { if (notify) { notify(); notify = null; } };
    app.on("settled", onSettled);

    try {
      while (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          notify = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal?.aborted) break;

        const newEvents = await app.query_array({ after: lastId });
        for (const e of serializeEvents(newEvents)) {
          yield tracked(String(e.id), e);
          lastId = e.id;
        }
      }
    } finally {
      app.off("settled", onSettled);
    }
  }),
});
```

### packages/app/src/api/auth.routes.ts (authentication endpoints)

```typescript
import { app, getAllUsers, getUserByEmail, getUserByProviderId, systemActor } from "@my-app/domain";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { hashPassword, signToken, verifyPassword } from "./auth.js";
import { t, publicProcedure, authedProcedure, adminProcedure } from "./trpc.js";

export const authRouter = t.router({
  login: publicProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ input }) => {
      const user = getUserByProviderId(input.username);
      if (!user || user.provider !== "local" || !user.passwordHash)
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      if (!verifyPassword(input.password, user.passwordHash))
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      const token = signToken({ email: user.email });
      return { user: { id: user.email, name: user.name, role: user.role }, token };
    }),

  signup: publicProcedure
    .input(z.object({ username: z.string(), name: z.string(), password: z.string() }))
    .mutation(async ({ input }) => {
      if (getUserByEmail(input.username))
        throw new TRPCError({ code: "CONFLICT", message: "User already exists" });
      const passwordHash = hashPassword(input.password);
      await app.do("RegisterUser", { stream: input.username, actor: { ...systemActor, name: "AuthSystem" } }, {
        email: input.username, name: input.name, provider: "local", providerId: input.username, passwordHash,
      });
      app.settle();
      const user = getUserByEmail(input.username);
      if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to register" });
      const token = signToken({ email: user.email });
      return { user: { id: user.email, name: user.name, role: user.role }, token };
    }),

  me: authedProcedure.query(({ ctx }) => ctx.actor),

  assignRole: adminProcedure
    .input(z.object({ email: z.string(), role: z.enum(["admin", "user"]) }))
    .mutation(async ({ input, ctx }) => {
      if (!getUserByEmail(input.email)) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      await app.do("AssignRole", { stream: input.email, actor: ctx.actor }, { role: input.role });
      app.settle();
      return { success: true };
    }),

  listUsers: adminProcedure.query(() => {
    return getAllUsers().map(({ passwordHash: _, ...profile }) => profile);
  }),
});
```

### packages/app/src/api/index.ts (router composition)

```typescript
import { authRouter } from "./auth.routes.js";
import { domainRouter } from "./domain.routes.js";
import { eventsRouter } from "./events.routes.js";
import { t } from "./trpc.js";

export { createContext, type Context } from "./context.js";

export const router = t.mergeRouters(authRouter, domainRouter, eventsRouter);
export type AppRouter = typeof router;
```

## App dev-server.ts (seed data + API)

```typescript
// packages/app/src/dev-server.ts
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { app, systemActor } from "@my-app/domain";
import { router, createContext } from "./api/index.js";
import { hashPassword } from "./api/auth.js";

async function seed() {
  const system = { ...systemActor, name: "Seed Script" };

  // Seed domain data via app.do()
  await app.do("CreateItem", { stream: "item-1", actor: system }, { name: "Example Item" });

  // Seed admin user
  const adminHash = hashPassword("admin");
  await app.do("RegisterUser", { stream: "admin", actor: system }, {
    email: "admin", name: "Admin", provider: "local", providerId: "admin", passwordHash: adminHash,
  });
  await app.do("AssignRole", { stream: "admin", actor: system }, { role: "admin" });

  // Drain reactions + projections
  for (let i = 0; i < 3; i++) {
    const { leased } = await app.correlate({ after: -1, limit: 500 });
    if (leased.length === 0) break;
    await app.drain({ streamLimit: 100, eventLimit: 500 });
  }

  console.log("Seeded dev data");
  console.log("  Admin user: admin/admin");
}

const server = createHTTPServer({
  middleware: cors({ origin: true, credentials: true }),
  router,
  createContext,
});
server.listen(4000);

await seed();
console.log("\nAPI server running at http://localhost:4000");
```

## App server.ts (production — serves built client + API)

```typescript
// packages/app/src/server.ts
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { app } from "@my-app/domain";
import { router, createContext } from "./api/index.js";

const server = createHTTPServer({
  middleware: cors({ origin: true, credentials: true }),
  router,
  createContext,
});
const port = Number(process.env.PORT) || 4000;
server.listen(port);

app.settle();
console.log(`Server listening on http://localhost:${port}`);
```

## App client — trpc.ts

```typescript
// packages/app/src/client/trpc.ts
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../api/index.js";

export const trpc = createTRPCReact<AppRouter>();
```

## App client — types.ts

```typescript
// packages/app/src/client/types.ts
export type EventEntry = {
  id: number;
  name: string;
  data: Record<string, unknown>;
  stream: string;
  version: number;
  created: string;
  meta: {
    correlation: string;
    causation: {
      action?: { stream: string; actor: { id: string; name: string }; name?: string };
      event?: { id: number; name: string; stream: string };
    };
  };
};

export type Tab = "shop" | "orders" | "admin";
```

## App client — App.tsx (with splitLink for SSE)

```tsx
// packages/app/src/client/App.tsx
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { trpc } from "./trpc.js";

const API_URL = "http://localhost:4000";

function getAuthHeaders() {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({ url: API_URL }),
          false: httpLink({ url: API_URL, headers: getAuthHeaders }),
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* Your components */}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
```

## App client — main.tsx

```tsx
// packages/app/src/client/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

## App client — hooks/useEventStream.ts (SSE + query invalidation)

```typescript
// packages/app/src/client/hooks/useEventStream.ts
import { useCallback, useRef, useState } from "react";
import { trpc } from "../trpc.js";
import type { EventEntry } from "../types.js";

export function useEventStream() {
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const seenIds = useRef(new Set<number>());
  const utils = trpc.useUtils();

  const onData = useCallback(
    (envelope: { id: string; data: EventEntry }) => {
      const evt = envelope.data;
      if (seenIds.current.has(evt.id)) return;
      seenIds.current.add(evt.id);
      setEvents((prev) => [...prev, evt]);

      // Invalidate relevant queries based on event name
      if (evt.name === "ItemCreated" || evt.name === "ItemClosed") {
        utils.getItems.invalidate();
      }
    },
    [utils]
  );

  trpc.onEvent.useSubscription(undefined, {
    onStarted: () => setConnected(true),
    onData,
    onError: () => setConnected(false),
  });

  return { events, connected };
}
```

## App client — hooks/useAuth.tsx (auth context + providers)

```tsx
// packages/app/src/client/hooks/useAuth.tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { trpc } from "../trpc.js";

type AuthUser = { id: string; name: string; picture?: string; role: "admin" | "user" };

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signUp: (username: string, name: string, password: string) => Promise<void>;
  signOut: () => void;
  isAdmin: boolean;
  error: string | null;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const TOKEN_KEY = "auth_token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loginMutation = trpc.login.useMutation();
  const signupMutation = trpc.signup.useMutation();
  const meQuery = trpc.me.useQuery(undefined, {
    enabled: !!localStorage.getItem(TOKEN_KEY),
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (meQuery.data) { setUser(meQuery.data as AuthUser); setLoading(false); }
    else if (meQuery.isError || !localStorage.getItem(TOKEN_KEY)) {
      if (meQuery.isError) localStorage.removeItem(TOKEN_KEY);
      setLoading(false);
    }
  }, [meQuery.data, meQuery.isError]);

  const signIn = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      const result = await loginMutation.mutateAsync({ username, password });
      localStorage.setItem(TOKEN_KEY, result.token);
      setUser(result.user as AuthUser);
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed"); }
  }, [loginMutation]);

  const signUp = useCallback(async (username: string, name: string, password: string) => {
    setError(null);
    try {
      const result = await signupMutation.mutateAsync({ username, name, password });
      localStorage.setItem(TOKEN_KEY, result.token);
      setUser(result.user as AuthUser);
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-up failed"); }
  }, [signupMutation]);

  const signOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setError(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut, isAdmin: user?.role === "admin", error }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
```

## Install Commands

```bash
mkdir my-app && cd my-app
pnpm init
mkdir -p packages/domain/{src,test} packages/app/src/{api,client/{hooks,components,views,styles,data}}

# Root devDependencies
pnpm add -Dw typescript tsx vitest @vitest/coverage-v8

# Domain
pnpm -F @my-app/domain add @rotorsoft/act zod

# App (server + client combined)
pnpm -F @my-app/app add @my-app/domain @rotorsoft/act @trpc/server @trpc/client @trpc/react-query @tanstack/react-query cors react react-dom zod
pnpm -F @my-app/app add -D @types/cors @types/react @types/react-dom @vitejs/plugin-react typescript vite
```
