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
 * import { webhookReceiver } from "@rotorsoft/act-http/receiver/express";
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
 *   webhookReceiver({ store: dedup, secret: process.env.WEBHOOK_SECRET }),
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
 * attaches `req.idempotency = { key, deduped }` and calls `next()`.
 *
 * **Raw body requirement**: when `secret` is configured, mount
 * `express.raw({ type: "application/json" })` (or whatever
 * content-type your webhooks use) ahead of the receiver middleware.
 * The middleware reads `req.body` as a `Buffer | string` and converts
 * to a UTF-8 string for hashing. Skip when unsigned.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { type CheckWebhookOptions, checkWebhook } from "../check.js";

/**
 * Build an Express middleware that verifies the request signature
 * (when `secret` is set), enforces `Idempotency-Key`, and claims the
 * key on the configured store. See the module-level docs for usage.
 */
export function webhookReceiver(options: CheckWebhookOptions): RequestHandler {
  return async function check(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const rawBody = bufferOrString(req.body);
    const result = await checkWebhook(
      req.headers as Record<string, string | string[] | undefined>,
      rawBody,
      options
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.reason });
      return;
    }
    (
      req as Request & { idempotency: { key: string; deduped: boolean } }
    ).idempotency = {
      key: result.key,
      deduped: result.deduped,
    };
    next();
  };
}

function bufferOrString(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "";
}
