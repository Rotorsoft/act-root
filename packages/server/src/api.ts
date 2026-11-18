import { type Calculator, calculatorApp } from "@act/calculator";
import { hono } from "@rotorsoft/act-http/hono";
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { trpc } from "@rotorsoft/act-http/trpc";
import type { z } from "zod";
import { resolveDemoActor } from "./demo-actor.js";

/**
 * The broadcast view of the calculator: the domain state plus the
 * `_v` version contract (`_v` is always the stream's head version,
 * `snap.version` — the event store is the single source of truth).
 */
export type LiveState = z.infer<typeof Calculator.state> & { _v: number };

// SSE broadcast. One in-memory channel shared by the generated tRPC
// subscriptions and REST stream routes below. `publish: true` has the
// generators publish every local commit to it once, as version-keyed patches
// (both generators share the channel, and each commit is still published
// once).
export const broadcast = new BroadcastChannel<LiveState>();

const stream = () => "calculator";
const sse = { channel: broadcast, publish: true };

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
