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
 * `Idempotency-Key`, retry with exponential backoff via ACT-601.
 *
 * URL is env-driven so the example runs against a stub by default.
 */
const ESCALATION_WEBHOOK_URL =
  process.env.WOLFDESK_ESCALATION_WEBHOOK ?? "https://example.com/escalations";

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
      timeoutMs: 2_000,
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
