/**
 * DEMO ONLY — no auth. This module exists so the multi-transport demo
 * (`src/server.ts`) has a single, loud, clearly-fake actor resolver
 * rather than an inline `() => ({ id: "1", name: "Calculator" })` that
 * reads like a production-ready template.
 *
 * Every generated mutation trusts the actor the transport resolves. In
 * production the host MUST resolve a *verified* actor from a JWT,
 * session cookie, mTLS identity, or API key — never a constant. Copying
 * this function into a real service is a privilege-escalation footgun:
 * it grants every caller the same identity with no authentication.
 *
 * On first use it logs a one-time warning so an operator who wires the
 * demo resolver into a real deployment sees the mistake in the logs
 * instead of silently shipping an unauthenticated API.
 */

import type { Actor } from "@rotorsoft/act";

let warned = false;

/**
 * A fake, constant actor for the local demo. Logs a one-time warning on
 * first call. NOT for production — resolve a verified actor from the
 * request instead (see `authenticated(...)` in `@rotorsoft/act-http/hono`
 * and the `actor: (c) => resolveActorFromJwt(c)` pattern in the README).
 */
export function resolveDemoActor(): Actor {
  if (!warned) {
    warned = true;
    console.warn(
      "[DEMO ONLY] resolveDemoActor() returns a hardcoded, UNAUTHENTICATED actor. " +
        "Production hosts MUST resolve a verified actor (JWT/session/mTLS) — " +
        "never ship this resolver."
    );
  }
  return { id: "1", name: "Calculator" };
}
