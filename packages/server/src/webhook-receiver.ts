/**
 * Standalone receiver demonstrating the receiver-side contract
 * end-to-end via the `receiver` builder from
 * `@rotorsoft/act-http/receiver`. Pair with the wolfdesk sender:
 *
 *   WOLFDESK_ESCALATION_WEBHOOK=http://localhost:4001/escalations
 *
 * The builder handles signature verification, dedup, raw-body
 * capture, schema validation, and HTTP server lifecycle. The
 * application code is just the typed event handler.
 *
 * Set `WEBHOOK_SECRET` to enable HMAC verification end-to-end with
 * the wolfdesk sender (which signs every request when the same env
 * var is set).
 */

import { receiver } from "@rotorsoft/act-http/receiver";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { z } from "zod";

const port = Number(process.env.WEBHOOK_RECEIVER_PORT) || 4001;

const EscalationPayload = z.object({
  ticket: z.string(),
  escalationId: z.string(),
});

const escalations = receiver({
  port,
  store: new InMemoryIdempotencyStore({
    // 24h dedup window — covers any reasonable retry+backoff envelope
    // from a sender using ACT-601 `exponential` backoff up to maxMs=30s.
    ttlMs: 24 * 60 * 60 * 1000,
    maxEntries: 50_000,
  }),
  secret: process.env.WEBHOOK_SECRET,
})
  .on("escalations", EscalationPayload, async (event, ctx) => {
    // Real handlers would: page operator, open incident, send email.
    // Demo prints to stdout so the wolfdesk run-through is visible.
    console.log(
      `[webhook] ticket=${event.ticket} escalation=${event.escalationId} key=${ctx.key}`
    );
  })
  .build();

await escalations.listen();
console.log(`[webhook-receiver] listening on http://localhost:${port}`);
