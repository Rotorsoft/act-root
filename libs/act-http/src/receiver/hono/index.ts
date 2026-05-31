/**
 * @packageDocumentation
 * @module act-http/receiver/hono
 *
 * Hono adapter for the receiver-side webhook check.
 *
 * Usage:
 *
 * ```ts
 * import { Hono } from "hono";
 * import { webhookMiddleware } from "@rotorsoft/act-http/receiver/hono";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 *
 * const app = new Hono();
 * const dedup = new InMemoryIdempotencyStore();
 *
 * app.post(
 *   "/webhooks/orders",
 *   webhookMiddleware({ store: dedup, secret: process.env.WEBHOOK_SECRET }),
 *   async (c) => {
 *     const idem = c.get("idempotency") as { key: string; deduped: boolean };
 *     if (idem.deduped) return c.json({ status: "dedup-skipped", key: idem.key });
 *     // ... process the inbound event ...
 *     return c.json({ status: "processed", key: idem.key });
 *   }
 * );
 * ```
 *
 * On failure: returns `c.json({ error: <reason> }, status)` directly
 * (Hono short-circuits when middleware returns a Response). On
 * success: stashes `c.set("idempotency", { key, deduped })` and
 * continues with `await next()`.
 *
 * **Raw body**: Hono exposes `await c.req.text()` natively, which
 * the middleware reads when `secret` is configured. No extra setup
 * needed.
 */
import type { MiddlewareHandler } from "hono";
import { type CheckWebhookOptions, checkWebhook } from "../check.js";

/**
 * Variables this middleware contributes to the Hono context. The
 * generic on the returned {@link MiddlewareHandler} threads it
 * through so route handlers downstream of `app.post(..., webhookMiddleware(...), handler)`
 * see `c.get("idempotency")` typed without a manual cast.
 */
export type WebhookVariables = {
  idempotency: { key: string; deduped: boolean };
};

/**
 * Build a Hono middleware that verifies the request signature (when
 * `secret` is set), enforces `Idempotency-Key`, and claims the key
 * on the configured store. See the module-level docs for usage.
 */
export function webhookMiddleware(
  options: CheckWebhookOptions
): MiddlewareHandler<{ Variables: WebhookVariables }> {
  return async function check(c, next) {
    const headers = headersBag(c.req.raw.headers);
    const rawBody = await c.req.text();
    const result = await checkWebhook(headers, rawBody, options);
    if (!result.ok) {
      return c.json({ error: result.reason }, result.status);
    }
    c.set("idempotency", { key: result.key, deduped: result.deduped });
    await next();
  };
}

function headersBag(
  headers: Headers
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
