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

// prettier-ignore
export const TicketWebhooksSlice = slice()
  .withState(TicketOperations)
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
  .to({ target: "ticket-escalation-webhooks" })
  .build();
