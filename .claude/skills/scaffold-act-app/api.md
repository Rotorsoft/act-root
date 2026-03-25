# API Layer

tRPC router in `packages/app/src/api/`, decomposed into focused route modules.

## Overview

| File | Purpose | Key pattern |
|---|---|---|
| `trpc.ts` | tRPC init + middleware | `publicProcedure`, `authedProcedure`, `adminProcedure` |
| `context.ts` | Request context | Extract `AppActor` from Bearer token via `verifyToken()` |
| `auth.ts` | Token + password crypto | HMAC-signed tokens, scrypt password hashing (zero deps) |
| `helpers.ts` | Event serialization | `serializeEvents()` for SSE payloads |
| `broadcast.ts` | Real-time state broadcast | `BroadcastChannel` + `PresenceTracker` from `@rotorsoft/act-sse` |
| `auth.routes.ts` | Auth endpoints | login, signup, me, assignRole, listUsers |
| `domain.routes.ts` | Domain mutations + queries | `app.do()` + `broadcastState()` per mutation; query projections |
| `events.routes.ts` | SSE subscriptions | `onStateChange` (incremental patches) + `onEvent` (replay) |
| `index.ts` | Router composition | `t.mergeRouters()` + export `AppRouter` type |

**Key rules:**
- Call `app.settle()` after every `app.do()` in mutations — non-blocking, returns immediately
- Call `broadcastState(streamId, snap)` after every `app.do()` — pushes incremental patches via `act-sse`
- Use `authedProcedure` / `adminProcedure` for authorization (middleware narrows `ctx.actor`)
- `onStateChange` SSE uses `broadcast.subscribe()` from `act-sse` for real-time state push
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

App-specific broadcast setup using `@rotorsoft/act-sse`. Customize `deriveState()` and `applyPresence()` for your domain.

```typescript
import { BroadcastChannel, PresenceTracker } from "@rotorsoft/act-sse";
import type { BroadcastState } from "@rotorsoft/act-sse";

// Extend with app-specific fields
export type AppState = BroadcastState & {
  // ... your domain state shape
};

export const broadcast = new BroadcastChannel<AppState>();
export const presence = new PresenceTracker();

type Snap = { state?: any; event?: { version: number; created: Date } };

/** Broadcast state after every app.do() — single entry point. */
export function broadcastState(streamId: string, snap: Snap) {
  const state = snap?.state;
  if (!state) return;

  const fullState: AppState = {
    ...state,
    _v: snap.event!.version,
    // ... app-specific computed fields (deadlines, etc.)
  };

  // Overlay presence on human players/users
  const withPresence = applyPresence(fullState, streamId);
  broadcast.publish(streamId, withPresence);
}

/** Re-broadcast with updated presence (called on connect/disconnect). */
export function broadcastPresenceChange(streamId: string) {
  const cached = broadcast.getState(streamId);
  if (!cached) return;
  const withPresence = applyPresence(cached, streamId);
  broadcast.publishOverlay(streamId, withPresence);
}

function applyPresence(state: AppState, streamId: string): AppState {
  // App-specific presence overlay — e.g., set `connected` on each player/user
  const online = presence.getOnline(streamId);
  // ... overlay online status onto state
  return state;
}
```

## packages/app/src/api/domain.routes.ts (domain commands + queries)

```typescript
import { app, getItems } from "@my-app/domain";
import { z } from "zod";
import { t, authedProcedure, adminProcedure, publicProcedure } from "./trpc.js";
import { broadcastState } from "./broadcast.js";
import { doAction } from "./app.js";

export const domainRouter = t.router({
  CreateItem: authedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const stream = crypto.randomUUID();
      const snap = await doAction("CreateItem", { stream, actor: ctx.actor }, input);
      broadcastState(stream, snap);  // incremental patch to SSE subscribers
      app.settle();                  // non-blocking — projections + reactions
      return { success: true, id: stream };
    }),

  getItems: publicProcedure.query(() => getItems()),
});
```

## packages/app/src/api/events.routes.ts (SSE subscriptions)

Two subscriptions: `onStateChange` for real-time incremental state push (uses `@rotorsoft/act-sse`), and `onEvent` for event stream replay.

```typescript
import { app } from "@my-app/domain";
import { tracked } from "@trpc/server";
import { z } from "zod";
import { serializeEvents } from "./helpers.js";
import { t, publicProcedure } from "./trpc.js";
import { broadcast, presence, broadcastPresenceChange } from "./broadcast.js";
import type { BroadcastMessage } from "@rotorsoft/act-sse";

export const eventsRouter = t.router({
  /**
   * Real-time state broadcast — incremental patches over SSE.
   * Uses @rotorsoft/act-sse for automatic RFC 6902 patch computation.
   */
  onStateChange: publicProcedure
    .input(z.object({ streamId: z.string(), identityId: z.string().optional() }).optional())
    .subscription(async function* ({ input, signal }) {
      const streamId = input?.streamId;
      if (!streamId) return;

      const identityId = input?.identityId;
      let resolve: (() => void) | null = null;
      let pending: BroadcastMessage | null = null;

      const cleanup = broadcast.subscribe(streamId, (msg) => {
        pending = msg;
        if (resolve) { resolve(); resolve = null; }
      });

      if (identityId) {
        presence.add(streamId, identityId);
        broadcastPresenceChange(streamId);
      }

      try {
        // Yield current state on connect (always full state for reconnects)
        const cached = broadcast.getState(streamId);
        if (cached) yield { _type: "full" as const, ...cached, serverTime: new Date().toISOString() };

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
            yield msg;
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

## packages/app/src/api/index.ts (router composition)

```typescript
import { authRouter } from "./auth.routes.js";
import { domainRouter } from "./domain.routes.js";
import { eventsRouter } from "./events.routes.js";
import { t } from "./trpc.js";

export { createContext, type Context } from "./context.js";

export const router = t.mergeRouters(authRouter, domainRouter, eventsRouter);
export type AppRouter = typeof router;
```
