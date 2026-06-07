import { slice } from "@rotorsoft/act";
import { webhook } from "@rotorsoft/act-http/webhook";
import { TicketOperations } from "./ticket-operations.js";

/**
 * Outbound webhook delivery for ticket lifecycle events.
 *
 * `TicketEscalated` is a natural "tell the outside world" moment — a
 * human operator gets paged, an external incident tracker opens a
 * record, etc. `webhook` from `@rotorsoft/act-http/webhook` is the
 * canonical fire-and-forget delivery path: short timeout, auto
 * `Idempotency-Key`, retry with exponential backoff via ACT-601,
 * optional HMAC-SHA256 signing when `WEBHOOK_SECRET` is set.
 *
 * URL is env-driven so the example runs against a stub by default.
 * `WEBHOOK_SECRET` is read at module load — set it on both the
 * sender (this slice) and the receiver (the standalone receiver in
 * `packages/server/src/webhook-receiver.ts`) to exercise the
 * end-to-end signed delivery path. When unset, both sides run
 * unsigned.
 */
const ESCALATION_WEBHOOK_URL =
  process.env.WOLFDESK_ESCALATION_WEBHOOK ?? "https://example.com/escalations";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/**
 * Webhook delivery rides on its own drain lane (ACT-1103). The lane
 * gets a 30 s `leaseMillis` so a slow external receiver doesn't trip
 * premature re-claim, plus a small `streamLimit` so a stuck endpoint
 * can't tie up a wide pool of leases. Other reactions in the app stay
 * on the `"default"` lane with their own (much shorter) lease budget;
 * `Act._drainAll` runs both controllers in parallel so the webhook
 * lane's in-flight POSTs don't block the rest of the pipeline.
 */
// prettier-ignore
export const TicketWebhooksSlice = slice()
  .withState(TicketOperations)
  .withLane({
    name: "webhooks",
    leaseMillis: 30_000,
    streamLimit: 5,
    cycleMs: 500,
  })
  .on("TicketEscalated")
  .do(
    webhook({
      url: ESCALATION_WEBHOOK_URL,
      body: (event) => ({
        ticket: event.stream,
        escalationId: (event.data as { escalationId: string }).escalationId,
      }),
      timeout_ms: 2_000,
      secret: WEBHOOK_SECRET,
    }),
    {
      maxRetries: 3,
      backoff: {
        strategy: "exponential",
        baseMs: 200,
        maxMs: 10_000,
        jitter: true,
      },
    }
  )
  .to({ target: "ticket-escalation-webhooks", lane: "webhooks" })
  .build();
