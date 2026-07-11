/**
 * @packageDocumentation
 * @module act-http/receiver/express
 *
 * Express adapter for the receiver-side webhook check.
 *
 * Usage:
 *
 * ```ts
 * import express from "express";
 * import { webhookMiddleware } from "@rotorsoft/act-http/receiver/express";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 *
 * const app = express();
 * const dedup = new InMemoryIdempotencyStore();
 *
 * // Raw body capture required when signing is enabled.
 * app.use(express.raw({ type: "application/json" }));
 *
 * app.post(
 *   "/webhooks/orders",
 *   webhookMiddleware({ store: dedup, secret: process.env.WEBHOOK_SECRET }),
 *   (req, res) => {
 *     const { key, deduped } = (req as any).idempotency;
 *     if (deduped) return res.json({ status: "dedup-skipped", key });
 *     // ... process the inbound event ...
 *     res.json({ status: "processed", key });
 *   }
 * );
 * ```
 *
 * On failure: responds with the framework-idiomatic JSON shape
 * `{ error: <reason> }` at status 400 (missing-key) or 401
 * (verification failures), and does not call `next()`. On success:
 * attaches `req.idempotency = { key, deduped, commit, release }` and
 * calls `next()`.
 *
 * **Two-phase dedup**: the claim is *tentative*. Express runs the
 * middleware to completion before the route handler, so — unlike the
 * Hono adapter — it can't observe the handler's outcome to finalize
 * automatically. The route handler **must** call
 * `req.idempotency.commit()` on success or `req.idempotency.release()`
 * on a transient failure. Skipping both leaves the claim tentative:
 * it dedups concurrent duplicates but expires on TTL, so the delivery
 * is never permanently lost — it just isn't durably deduped either.
 *
 * **Raw body requirement**: when `secret` is configured, mount
 * `express.raw({ type: "application/json" })` (or whatever
 * content-type your webhooks use) ahead of the receiver middleware.
 * The middleware reads `req.body` as a `Buffer | string` and converts
 * to a UTF-8 string for hashing. Skip when unsigned.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { type CheckWebhookOptions, checkWebhook } from "../check.js";
import { type Finalizers, make_finalizers } from "../finalize.js";

/** Shape attached to `req.idempotency` by the Express adapter. */
export type ExpressIdempotency = {
  key: string;
  deduped: boolean;
} & Finalizers;

/**
 * Build an Express middleware that verifies the request signature
 * (when `secret` is set), enforces `Idempotency-Key`, and claims the
 * key on the configured store. See the module-level docs for usage.
 */
export function webhookMiddleware(
  options: CheckWebhookOptions
): RequestHandler {
  return async function check(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const rawBody = buffer_or_string(req.body);
    const result = await checkWebhook(
      req.headers as Record<string, string | string[] | undefined>,
      rawBody,
      options
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.reason });
      return;
    }
    const { commit, release } = make_finalizers(
      options.store,
      result.key,
      result.deduped
    );
    (req as Request & { idempotency: ExpressIdempotency }).idempotency = {
      key: result.key,
      deduped: result.deduped,
      commit,
      release,
    };
    next();
  };
}

function buffer_or_string(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "";
}
