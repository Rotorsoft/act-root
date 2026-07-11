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
 * **Two-phase dedup**: the claim `checkWebhook` makes is *tentative*.
 * Because Hono middleware wraps the downstream chain, this adapter
 * finalizes the claim automatically after `await next()`: a downstream
 * 2xx **commits** the key (later retries dedup); a 5xx or a thrown
 * handler **releases** it (the sender's retry re-processes instead of
 * being silently dropped). Operators who need explicit control can
 * still call `c.get("idempotency").commit()` / `.release()`.
 *
 * **Raw body**: Hono exposes `await c.req.text()` natively, which
 * the middleware reads when `secret` is configured. No extra setup
 * needed.
 */
import type { MiddlewareHandler } from "hono";
import { type CheckWebhookOptions, checkWebhook } from "../check.js";
import { make_finalizers } from "../finalize.js";

/**
 * Variables this middleware contributes to the Hono context. The
 * generic on the returned {@link MiddlewareHandler} threads it
 * through so route handlers downstream of `app.post(..., webhookMiddleware(...), handler)`
 * see `c.get("idempotency")` typed without a manual cast.
 *
 * `commit` / `release` finalize the tentative claim — call one after
 * the handler resolves its outcome. This adapter also finalizes
 * automatically based on the response status, so explicit calls are
 * only needed when the auto-detection doesn't fit.
 */
export type WebhookVariables = {
  idempotency: {
    key: string;
    deduped: boolean;
    commit: () => void | Promise<void>;
    release: () => void | Promise<void>;
  };
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
    const headers = headers_bag(c.req.raw.headers);
    const rawBody = await c.req.text();
    const result = await checkWebhook(headers, rawBody, options);
    if (!result.ok) {
      return c.json({ error: result.reason }, result.status);
    }
    const { commit, release } = make_finalizers(
      options.store,
      result.key,
      result.deduped
    );
    c.set("idempotency", {
      key: result.key,
      deduped: result.deduped,
      commit,
      release,
    });
    try {
      await next();
    } catch (err) {
      await release();
      throw err;
    }
    if (c.res.status >= 500) await release();
    else await commit();
  };
}

function headers_bag(
  headers: Headers
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
