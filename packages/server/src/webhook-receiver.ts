/**
 * Standalone webhook receiver demonstrating the receiver-side
 * contract end-to-end via the **high-level** `webhookReceiver` port
 * from `@rotorsoft/act-http/receiver`. Pair with the wolfdesk sender
 * by setting:
 *
 *   WOLFDESK_ESCALATION_WEBHOOK=http://localhost:4001/escalations
 *
 * The high-level adapter handles signature verification, dedup, raw-
 * body capture, schema validation, and HTTP server lifecycle. The
 * application code is just the typed event handler.
 *
 * Set `WEBHOOK_SECRET` to enable HMAC verification end-to-end with
 * the wolfdesk sender (which signs every request when the same env
 * var is set).
 */

import { webhookReceiver } from "@rotorsoft/act-http/receiver";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { z } from "zod";

const dedup = new InMemoryIdempotencyStore({
  // 24h dedup window — covers any reasonable retry+backoff envelope
  // from a sender using ACT-601 `exponential` backoff up to maxMs=30s.
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 50_000,
});

const EscalationPayload = z.object({
  ticket: z.string(),
  escalationId: z.string(),
});

/**
 * Build a receiver wired with the escalation handler. Exported so
 * tests can spin it up at a known port without going through the
 * CLI bootstrap path.
 */
export function buildReceiver(port: number) {
  return webhookReceiver({
    port,
    store: dedup,
    secret: process.env.WEBHOOK_SECRET,
  }).on("escalations", EscalationPayload, async (event, ctx) => {
    // Real handlers would: page operator, open incident, send email.
    // Demo prints to stdout so the wolfdesk run-through is visible.
    console.log(
      `[webhook] ticket=${event.ticket} escalation=${event.escalationId} key=${ctx.key}`
    );
  });
}

/**
 * Start the receiver. Returns a `close()` handle for tests.
 */
export async function startWebhookReceiver(port = 4001): Promise<{
  close: () => Promise<void>;
}> {
  const receiver = buildReceiver(port);
  await receiver.listen();
  return { close: () => receiver.close() };
}

// Run-from-CLI: `tsx src/webhook-receiver.ts` boots on port 4001.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.WEBHOOK_RECEIVER_PORT) || 4001;
  await startWebhookReceiver(port);
  console.log(`[webhook-receiver] listening on http://localhost:${port}`);
}
