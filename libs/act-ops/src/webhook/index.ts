/**
 * @packageDocumentation
 * @module act-ops/webhook
 *
 * High-level webhook-receiver port. Operators who pick act-ops get
 * the opinionated path: pick an adapter, register typed handlers
 * fluently, call `.listen()` (or `.fetch(request)` for edge / Lambda).
 *
 * ```ts
 * import { webhookReceiver } from "@rotorsoft/act-http/receiver/hono";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 * import { z } from "zod";
 *
 * const receiver = webhookReceiver({
 *   port: 4001,
 *   store: new InMemoryIdempotencyStore(),
 *   secret: process.env.WEBHOOK_SECRET,
 * })
 *   .on("OrderConfirmed", z.object({ orderId: z.string() }), async (event, ctx) => {
 *     // event is typed; ctx.key is the dedup key
 *   });
 *
 * await receiver.listen();
 * ```
 *
 * For operators who want fine control — custom path routing, auth
 * middleware composition, non-standard HTTP server lifecycle — the
 * lower-level `webhookMiddleware` factory in
 * `@rotorsoft/act-http/receiver/<framework>` stays available as the
 * escape hatch.
 */

export type {
  Validator,
  WebhookContext,
  WebhookReceiver,
  WebhookReceiverOptions,
} from "./port.js";
