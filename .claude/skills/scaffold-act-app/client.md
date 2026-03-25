# Client Layer

React + Vite frontend in `packages/app/src/client/`.

**The client has two real-time data flows — understand which to use where:**

1. **State stream** (`useStateStream`) — subscribes to a *single entity's state* via `onStateChange`. The server pushes incremental JSON patches (RFC 6902) after every mutation. Use this for detail views where you're watching one entity (a game board, an order, a ticket). The hook applies patches to the React Query cache directly — no refetch needed.

2. **Event stream** (`useEventStream`) — subscribes to the *global event log* via `onEvent`. Every event across all streams arrives here. Use this for event replay UIs, admin dashboards, and activity feeds. It triggers cache invalidation on relevant queries (e.g., invalidate the list when an item is created).

**Most views need state stream, not event stream.** A common mistake is subscribing to the event stream to watch for changes to a specific entity — that's what the state stream is for. The event stream is for cross-entity awareness.

**splitLink is required, not optional.** tRPC SSE subscriptions use `httpSubscriptionLink`, while mutations/queries use `httpLink`. Without `splitLink`, subscriptions will fail with HTTP errors because `httpLink` doesn't support the SSE protocol.

**Version handling in useStateStream:** The hook handles 4 cases from `applyBroadcastMessage()`: `ok` (apply patch to cache), `behind` (client missed a version — invalidate and refetch), `patch-failed` (patch couldn't apply — invalidate and refetch), `stale` (client is ahead because the mutation response arrived before the SSE patch — ignore). Getting these wrong causes UI glitches or infinite refetch loops.

## Key Patterns

- `App.tsx` uses `splitLink` — routes subscriptions through `httpSubscriptionLink` (SSE), mutations/queries through `httpLink`
- `useStateStream` hook subscribes to `onStateChange` SSE, applies incremental patches via `applyBroadcastMessage()` from `@rotorsoft/act-sse`
- `useEventStream` hook subscribes to `onEvent` SSE, deduplicates by event ID, and calls `utils.<query>.invalidate()` on relevant events
- `useAuth` hook provides `AuthProvider` context with `signIn`, `signUp`, `signOut`, and role-based access (`isAdmin`)

## packages/app/src/client/trpc.ts

```typescript
// packages/app/src/client/trpc.ts
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../api/index.js";

export const trpc = createTRPCReact<AppRouter>();
```

## packages/app/src/client/types.ts

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

## packages/app/src/client/App.tsx (with splitLink for SSE)

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

## packages/app/src/client/main.tsx

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

## packages/app/src/client/hooks/useStateStream.ts (incremental state sync via act-sse)

Receives incremental patches or full state from the server, applies them to the React Query cache with version validation. Falls back to full refetch on version mismatch.

```typescript
// packages/app/src/client/hooks/useStateStream.ts
import { useCallback, useState } from "react";
import { applyBroadcastMessage } from "@rotorsoft/act-sse";
import { trpc } from "../trpc.js";

export function useStateStream(streamId: string | null, identityId?: string) {
  const [connected, setConnected] = useState(false);
  const utils = trpc.useUtils();

  const onStarted = useCallback(() => {
    setConnected(true);
    if (streamId) utils.getState.invalidate({ streamId });
  }, [streamId, utils]);

  trpc.onStateChange.useSubscription(
    streamId ? { streamId, identityId } : undefined,
    {
      onStarted,
      onData: (msg) => {
        if (!streamId) return;
        const cached = utils.getState.getData({ streamId }) as any;
        const result = applyBroadcastMessage(msg as any, cached);

        if (result.ok) {
          utils.getState.setData({ streamId }, result.state as any);
        } else if (result.reason === "behind" || result.reason === "patch-failed") {
          utils.getState.invalidate({ streamId });
        }
        // "stale" → no-op (client already has newer state from mutation response)
      },
      onError: () => setConnected(false),
    }
  );

  return { connected };
}
```

## packages/app/src/client/hooks/useEventStream.ts (event log via SSE)

For event replay views and admin tools. Uses the `onEvent` subscription with deduplication.

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

## packages/app/src/client/hooks/useAuth.tsx (auth context + providers)

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
