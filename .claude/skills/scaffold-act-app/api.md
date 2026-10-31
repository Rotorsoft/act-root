# API Layer

tRPC router in `packages/app/src/api/`, decomposed into focused route modules.

> **Domain mutations are generated, never hand-written.** `trpc(app, { actor, stream })` from `@rotorsoft/act-http/trpc` emits one mutation per registered action, typed from the app: each takes its action's Zod payload and returns the snapshots `app.do` returns, so the client's `createTRPCReact<AppRouter>()` is typed end to end with no casts. With `sse: { channel }` it also emits one typed `subscribe.<State>` per state; a state whose events declare `sensitive(...)` fields can't be broadcast, and generation throws, so keep PII in a state you don't stream. Hand-write only what the generator doesn't cover: auth, admin routes, projection queries, the global `onEvent` replay, and a state subscription that needs presence. Merge them with `t.mergeRouters` (see `index.ts`).

**Why decompose into many small files instead of one router?** Each file has a single responsibility and a clear dependency graph. `trpc.ts` knows nothing about auth; `context.ts` knows nothing about routes; route files know nothing about each other. This prevents circular dependencies and makes it easy to find where a specific endpoint lives. When the spec adds a new domain aggregate, you add handlers to `domain.routes.ts` without touching auth or SSE logic.

**Broadcast once, on `committed`.** `app.on("committed", Item, ...)` in `broadcast.ts`, scoped to the state so its snapshots are typed, publishes every commit, whichever path made it: a generated mutation, a reaction, a timer. No mutation calls `broadcastState()` itself, so none can forget to. Reactions and projections run on their own after the commit. A generated mutation returns the snapshots of its own commit; never answer a request from a projection, which may lag.

**Choosing the right procedure type:** Use `publicProcedure` for unauthenticated reads (list views, SSE subscriptions). Use `authedProcedure` for any mutation that modifies state — the middleware guarantees `ctx.actor` is non-null and typed. Use `adminProcedure` for administrative operations (role assignment, user management). Never use `publicProcedure` for mutations unless the spec explicitly allows anonymous writes.

**Two SSE subscriptions serve different purposes:** `onStateChange` pushes incremental state patches for a *specific stream* (one entity) — used by detail views. `onEvent` replays the *global event log* — used by admin tools and event explorers. Don't confuse them: `onStateChange` uses `broadcast.subscribe()` (via @rotorsoft/act-http/sse), while `onEvent` uses `app.on("settled")` (framework lifecycle).

## Overview

| File | Purpose | Key pattern |
|---|---|---|
| `trpc.ts` | tRPC init + middleware | `publicProcedure`, `authedProcedure`, `adminProcedure` |
| `context.ts` | Request context | Extract `AppActor` from Bearer token via `verifyToken()` |
| `auth.ts` | Token + password crypto | HMAC-signed tokens, scrypt password hashing (zero deps) |
| `helpers.ts` | Event serialization | `serializeEvents()` for SSE payloads |
| `broadcast.ts` | Real-time state broadcast | `BroadcastChannel` + `PresenceTracker` from `@rotorsoft/act-http/sse` |
| `auth.routes.ts` | Auth endpoints | login, signup, me, assignRole, listUsers |
| `domain.routes.ts` | Domain mutations + queries | `trpc(app, ...)` for every action; hand-written projection queries |
| `events.routes.ts` | SSE subscriptions | `onStateChange` (incremental patches) + `onEvent` (replay) |
| `index.ts` | Router composition | `t.mergeRouters()` + export `AppRouter` type |

**Key rules:**
- Don't call `app.settle()` in mutations — each commit settles its reactions on its own
- Generate the domain mutations with `trpc(app, ...)`; never hand-write a procedure that only calls `app.do()`
- Broadcasting runs from one `app.on("committed", State, ...)` listener per broadcast state (snapshots typed, no casts) — pushes incremental patches via `@rotorsoft/act-http/sse`
- Use `authedProcedure` / `adminProcedure` for authorization (middleware narrows `ctx.actor`)
- `onStateChange` SSE uses `broadcast.subscribe()` from `@rotorsoft/act-http/sse` for real-time state push
- `onEvent` SSE uses `app.on("settled", ...)` which fires only after `correlate()` + `drain()` complete

## packages/app/src/api/trpc.ts (init + middleware)

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

## packages/app/src/api/context.ts (request context + auth)

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

## packages/app/src/api/auth.ts (token + password crypto)

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

## packages/app/src/api/helpers.ts (event serialization)

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

## packages/app/src/api/broadcast.ts (broadcast setup)

App-specific broadcast setup using `@rotorsoft/act-http/sse`. Customize `deriveState()` and `applyPresence()` for your domain.

```typescript
import { app, Item } from "@my-app/domain";
import { BroadcastChannel, PresenceTracker } from "@rotorsoft/act-http/sse";
import type { z } from "zod";

// The broadcast view: the domain state, its stream version, and any
// app-specific computed fields (deadlines, etc.)
export type AppState = z.infer<typeof Item.state> & { _v: number };

export const broadcast = new BroadcastChannel<AppState>();
export const presence = new PresenceTracker();

/**
 * Broadcast every commit by the state's actions: generated mutations,
 * reactions and timers alike. Scoped to the state, so `snaps` is typed
 * from it. One listener per broadcast state.
 */
app.on("committed", Item, (snaps) => {
  const last = snaps.at(-1);
  if (!last?.event) return;
  const streamId = last.event.stream;
  const fullState: AppState = {
    ...last.state,
    _v: last.event.version, // MUST come from the event store version
  };
  // One domain patch per emitted event, in commit order
  const patches = snaps.map((s) => s.patch ?? {});
  // Overlay presence on human players/users
  broadcast.publish(streamId, applyPresence(fullState, streamId), patches);
});

/** Re-broadcast with updated presence (called on connect/disconnect). */
export function broadcastPresenceChange(streamId: string) {
  const cached = broadcast.state(streamId);
  if (!cached) return;
  const withPresence = applyPresence(cached, streamId);
  broadcast.overlay(streamId, withPresence);
}

function applyPresence(state: AppState, streamId: string): AppState {
  // App-specific presence overlay — e.g., set `connected` on each player/user
  const online = presence.online(streamId);
  // ... overlay online status onto state
  return state;
}
```

Always use the short names (`overlay`, `state`, `online`, `isOnline`) — the snake_case names are deprecated aliases removed in the next major.

## packages/app/src/api/domain.routes.ts (domain commands + queries)

The mutations come from the generator, typed from the app; only the projection queries are hand-written.

```typescript
import { app, getItems } from "@my-app/domain";
import { TRPCError } from "@trpc/server";
import { trpc } from "@rotorsoft/act-http/trpc";
import { z } from "zod";
import { broadcast } from "./broadcast.js";
import type { Context } from "./context.js";
import { t, publicProcedure } from "./trpc.js";

/** One typed mutation per action: payload in, snapshots out. */
export const domainRouter = trpc<Context, typeof app>(app, {
  // Throwing denies the call with UNAUTHORIZED.
  actor: (ctx) => {
    if (!ctx.actor) throw new TRPCError({ code: "UNAUTHORIZED" });
    return ctx.actor;
  },
  // Checking `action` narrows `input` (declare all three parameters).
  stream: (action, input, _ctx) =>
    action === "CreateItem" ? crypto.randomUUID() : input.itemId,
});

export const queriesRouter = t.router({
  getItems: publicProcedure.query(() => getItems()),
  /** The live state `useStateStream` seeds and patches; null before the first commit. */
  getState: publicProcedure
    .input(z.object({ streamId: z.string() }))
    .query(({ input }) => broadcast.state(input.streamId) ?? null),
});
```

The client reads the new item's id from the returned snapshot: `(await client.CreateItem.mutate({ name })).at(-1)?.event?.stream`. Role checks that depend on the action (admin-only actions) go in the action's `.requires([...])` preconditions, where every transport enforces them, not in the router.

## packages/app/src/api/events.routes.ts (SSE subscriptions)

Two subscriptions: `onStateChange` for real-time incremental state push (uses `@rotorsoft/act-http/sse`), and `onEvent` for event stream replay.

```typescript
import { app } from "@my-app/domain";
import { tracked } from "@trpc/server";
import { z } from "zod";
import { serializeEvents } from "./helpers.js";
import { t, publicProcedure } from "./trpc.js";
import {
  type AppState,
  broadcast,
  presence,
  broadcastPresenceChange,
} from "./broadcast.js";
import type { PatchMessage } from "@rotorsoft/act-http/sse";

export const eventsRouter = t.router({
  /**
   * Real-time state broadcast — incremental patches over SSE.
   * Forwards version-keyed domain patch messages from @rotorsoft/act-http/sse.
   */
  onStateChange: publicProcedure
    .input(z.object({ streamId: z.string(), identityId: z.string().optional() }).optional())
    .subscription(async function* ({ input, signal }) {
      const streamId = input?.streamId;
      if (!streamId) return;

      const identityId = input?.identityId;
      let resolve: (() => void) | null = null;
      let pending: PatchMessage<AppState> | null = null;

      const cleanup = broadcast.subscribe(streamId, (msg) => {
        pending = msg;
        if (resolve) { resolve(); resolve = null; }
      });

      if (identityId) {
        presence.add(streamId, identityId);
        broadcastPresenceChange(streamId);
      }

      try {
        // Yield cached state on connect (full state for first paint / reconnects)
        const cached = broadcast.state(streamId);
        if (cached) yield { kind: "snap" as const, state: cached };

        while (!signal?.aborted) {
          if (!pending) {
            await new Promise<void>((r) => {
              resolve = r;
              signal?.addEventListener("abort", () => r(), { once: true });
            });
          }
          if (signal?.aborted) break;
          if (pending) {
            const msg = pending;
            pending = null;
            yield { kind: "patch" as const, msg };
          }
        }
      } finally {
        cleanup();
        if (identityId) {
          presence.remove(streamId, identityId);
          broadcastPresenceChange(streamId);
        }
      }
    }),

  /** Event stream — for replays and admin tools */
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

## packages/app/src/api/auth.routes.ts (authentication endpoints)

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
      return { success: true };
    }),

  listUsers: adminProcedure.query(() => {
    return getAllUsers().map(({ passwordHash: _, ...profile }) => profile);
  }),
});
```

## packages/app/src/api/index.ts (router composition)

```typescript
import { authRouter } from "./auth.routes.js";
import { domainRouter, queriesRouter } from "./domain.routes.js";
import { eventsRouter } from "./events.routes.js";
import { t } from "./trpc.js";

export { createContext, type Context } from "./context.js";

export const router = t.mergeRouters(
  authRouter,
  domainRouter,
  queriesRouter,
  eventsRouter
);
export type AppRouter = typeof router;
```
