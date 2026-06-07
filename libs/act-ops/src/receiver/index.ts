/**
 * @packageDocumentation
 * @module act-ops/receiver
 *
 * Generic inbound-receiver port. Transport-agnostic — the same
 * `Receiver` interface fits HTTP webhooks (shipped today), bus
 * consumers (Kafka/SQS/NATS/RabbitMQ — future tickets), CDC streams,
 * WebSocket subscribers, scheduled pollers, and any other "external
 * events arrive into this Act app" pattern.
 *
 * Operators who pick act-ops get the opinionated path: pick a
 * transport adapter (today: `@rotorsoft/act-http/receiver` for HTTP
 * webhooks), register typed handlers fluently with Zod schemas,
 * `.build()` to finalize, then `.listen()` (Node server) or
 * `.fetch(request)` (Lambda / edge).
 *
 * ```ts
 * import { webhookReceiver } from "@rotorsoft/act-http/receiver";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 * import { z } from "zod";
 *
 * const receiver = webhookReceiver({
 *   port: 4001,
 *   store: new InMemoryIdempotencyStore(),
 *   secret: process.env.WEBHOOK_SECRET,
 * })
 *   .on("OrderConfirmed", z.object({ order_id: z.string() }), async (event, ctx) => {
 *     // event is typed; ctx.key is the dedup key
 *   })
 *   .build();
 *
 * await receiver.listen();
 * ```
 *
 * Matches Act's builder pattern: the factory returns a
 * {@link ReceiverBuilder} that collects handlers; `.build()`
 * finalizes and produces an immutable {@link Receiver} with only
 * runtime methods. You can't accidentally register a handler on a
 * running receiver — the lifecycle phases are split at the type
 * level.
 *
 * For operators who want fine control — custom path routing, auth
 * middleware composition, non-standard HTTP server lifecycle — the
 * lower-level `webhookMiddleware` factory in
 * `@rotorsoft/act-http/receiver/<framework>` stays available as the
 * escape hatch.
 */

export type {
  Receiver,
  ReceiverBuilder,
  ReceiverContext,
  ReceiverOptions,
  Validator,
} from "./port.js";
