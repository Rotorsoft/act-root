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
 * import { webhookMiddleware } from "@rotorsoft/act-http/receiver/fastify";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 *
 * const app = Fastify();
 * const dedup = new InMemoryIdempotencyStore();
 *
 * app.post(
 *   "/webhooks/orders",
 *   {
 *     preHandler: webhookMiddleware({
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
 * `request.idempotency = { key, deduped, commit, release }` and lets
 * the route handler run.
 *
 * **Two-phase dedup**: the claim is *tentative*. A Fastify
 * `preHandler` runs to completion before the route handler, so — like
 * the Express adapter — it can't finalize automatically. The route
 * handler **must** call `request.idempotency.commit()` on success or
 * `request.idempotency.release()` on a transient failure. Skipping
 * both leaves the claim tentative: it dedups concurrent duplicates but
 * expires on TTL, so a delivery is never permanently lost — it just
 * isn't durably deduped either.
 *
 * **Raw body requirement**: when `secret` is configured, register a
 * content-type parser that preserves the raw body string. Fastify's
 * default JSON parser eats the bytes — register a custom parser via
 * `app.addContentTypeParser("application/json", { parseAs: "string" }, …)`
 * and stash the string on `request.rawBody` (Fastify pattern). The
 * middleware reads `request.rawBody` for hashing. Skip when unsigned.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { type CheckWebhookOptions, checkWebhook } from "../check.js";
import { type Finalizers, make_finalizers } from "../finalize.js";

/** Shape attached to `request.idempotency` by the Fastify adapter. */
export type FastifyIdempotency = {
  key: string;
  deduped: boolean;
} & Finalizers;

type WebhookRequest = FastifyRequest & {
  rawBody?: string;
  idempotency?: FastifyIdempotency;
};

/**
 * Build a Fastify `preHandler` hook that verifies the request
 * signature (when `secret` is set), enforces `Idempotency-Key`, and
 * claims the key on the configured store. See the module-level docs
 * for usage.
 */
export function webhookMiddleware(
  options: CheckWebhookOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function check(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const req = request as WebhookRequest;
    const rawBody = req.rawBody ?? "";
    const result = await checkWebhook(
      req.headers as Record<string, string | string[] | undefined>,
      rawBody,
      options
    );
    if (!result.ok) {
      await reply.status(result.status).send({ error: result.reason });
      return;
    }
    const { commit, release } = make_finalizers(
      options.store,
      result.key,
      result.deduped
    );
    req.idempotency = {
      key: result.key,
      deduped: result.deduped,
      commit,
      release,
    };
  };
}
