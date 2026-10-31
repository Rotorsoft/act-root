import { type Calculator, calculatorApp } from "@act/calculator";
import { hono } from "@rotorsoft/act-http/hono";
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { trpc } from "@rotorsoft/act-http/trpc";
import type { z } from "zod";
import { resolveDemoActor } from "./demo-actor.js";

/**
 * The broadcast view of the calculator: the domain state plus the
 * `_v` version contract (`_v` is always `snap.event.version` — the
 * event store's stream version is the single source of truth).
 */
export type LiveState = z.infer<typeof Calculator.state> & { _v: number };

// SSE broadcast. One in-memory channel shared by the generated tRPC
// subscriptions and REST stream routes below. Publication is host-owned:
// every local commit, from either transport, lands here via the
// `committed` lifecycle event and fans out as version-keyed patches.
export const broadcast = new BroadcastChannel<LiveState>();
calculatorApp.on("committed", (snapshots) => {
  // The lifecycle payload is loosely typed by design — commits from any
  // registered state land here. This app registers a single state, so
  // narrow to its shape once.
  const snaps = snapshots as unknown as {
    state: Omit<LiveState, "_v">;
    event?: { stream: string; version: number };
    patch?: Partial<LiveState>;
  }[];
  const last = snaps.at(-1);
  if (!last?.event) return;
  broadcast.publish(
    last.event.stream,
    { ...last.state, _v: last.event.version },
    snaps
      .map((s) => s.patch)
      .filter((p): p is Partial<LiveState> => p !== undefined)
  );
});

const stream = () => "calculator";
const sse = { channel: broadcast };

// DEMO ONLY — no auth; production hosts MUST resolve a verified actor.
// Every generated mutation trusts whatever this returns. In a real
// service, resolve the actor from a verified JWT / session / mTLS
// identity off the request context — e.g.
//   actor: (c) => resolveActorFromJwt(c)
// (see `authenticated(...)` in `@rotorsoft/act-http/hono`). Copying the
// hardcoded resolver into production is a privilege-escalation footgun:
// it grants every caller the same identity with no auth.
// `resolveDemoActor()` logs a one-time warning if it ever runs outside
// the demo, so the mistake surfaces in the logs.
const actor = () => resolveDemoActor();

/** The tRPC router: one mutation per action, one subscription per state. */
export const router = trpc(calculatorApp, { actor, stream, sse });

/** The REST routes: `POST /api/actions/<name>`, `GET /api/sse/<state>`. */
export const api = hono(calculatorApp, { actor, stream, sse });

/** What the client imports, as a type only: the APIs above, as built. */
export type AppRouter = typeof router;
export type Api = typeof api;
