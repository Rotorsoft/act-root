/**
 * @packageDocumentation
 * @module act-http/receiver/fastify
 *
 * Fastify adapter for the receiver-side webhook check.
 *
 * Usage:
 *
 * ```ts
 * import Fastify from "fastify";
 * import { webhook_middleware } from "@rotorsoft/act-http/receiver/fastify";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 *
 * const app = Fastify();
 * const dedup = new InMemoryIdempotencyStore();
 *
 * app.post(
 *   "/webhooks/orders",
 *   {
 *     preHandler: webhook_middleware({
 *       store: dedup,
 *       secret: process.env.WEBHOOK_SECRET,
 *     }),
 *   },
 *   async (request, reply) => {
 *     const { key, deduped } = (request as any).idempotency;
 *     if (deduped) return { status: "dedup-skipped", key };
 *     // ... process the inbound event ...
 *     return { status: "processed", key };
 *   }
 * );
 * ```
 *
 * On failure: replies with `{ error: <reason> }` at status 400
 * (missing-key) or 401 (verification failures). On success: attaches
 * `request.idempotency = { key, deduped }` and lets the route handler
 * run.
 *
 * **Raw body requirement**: when `secret` is configured, register a
 * content-type parser that preserves the raw body string. Fastify's
 * default JSON parser eats the bytes — register a custom parser via
 * `app.addContentTypeParser("application/json", { parse_as: "string" }, …)`
 * and stash the string on `request.raw_body` (Fastify pattern). The
 * middleware reads `request.raw_body` for hashing. Skip when unsigned.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { type CheckWebhookOptions, check_webhook } from "../check.js";

type WebhookRequest = FastifyRequest & {
  raw_body?: string;
  idempotency?: { key: string; deduped: boolean };
};

/**
 * Build a Fastify `preHandler` hook that verifies the request
 * signature (when `secret` is set), enforces `Idempotency-Key`, and
 * claims the key on the configured store. See the module-level docs
 * for usage.
 */
export function webhook_middleware(
  options: CheckWebhookOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function check(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const req = request as WebhookRequest;
    const raw_body = req.raw_body ?? "";
    const result = await check_webhook(
      req.headers as Record<string, string | string[] | undefined>,
      raw_body,
      options
    );
    if (!result.ok) {
      await reply.status(result.status).send({ error: result.reason });
      return;
    }
    req.idempotency = { key: result.key, deduped: result.deduped };
  };
}
