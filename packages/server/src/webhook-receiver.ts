/**
 * Standalone webhook receiver demonstrating the receiver-side
 * contract end-to-end. Pair with the wolfdesk sender by setting:
 *   WOLFDESK_ESCALATION_WEBHOOK=http://localhost:4001/escalations
 *
 * Composes the framework-agnostic `checkWebhook` core with the tRPC
 * adapter from `@rotorsoft/act-http/receiver/trpc`. The middleware
 * does three things: verify the signature (when configured), enforce
 * `Idempotency-Key`, claim the key on the in-memory store. Failures
 * become tRPC errors; the handler runs only when all three pass and
 * sees `ctx.idempotency = { key, deduped }`.
 *
 * Set `WEBHOOK_SECRET` to enable HMAC verification. The wolfdesk
 * sender (when configured with the same secret) will sign every
 * request; the receiver will reject unsigned, stale, or tampered
 * deliveries with 401.
 */

import { webhookReceiver } from "@rotorsoft/act-http/receiver/trpc";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { initTRPC } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { z } from "zod";

/**
 * tRPC context shape — the receiver middleware requires `headers`
 * and `rawBody`. `rawBody` is captured in `createContext` below.
 */
type Ctx = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
};

const t = initTRPC.context<Ctx>().create();

const dedup = new InMemoryIdempotencyStore({
  // 24h dedup window — covers any reasonable retry+backoff envelope
  // from a sender using ACT-601 `exponential` backoff up to maxMs=30s.
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 50_000,
});

const idempotent = t.procedure.use(
  webhookReceiver({
    store: dedup,
    // When set, sign every request on the wolfdesk side with the same
    // value. Leave unset for unsigned mode.
    secret: process.env.WEBHOOK_SECRET,
  })
);

const EscalationPayload = z.object({
  ticket: z.string(),
  escalationId: z.string(),
});

export const webhookRouter = t.router({
  /**
   * Inbound webhook for ticket escalations. The middleware has
   * already verified + dedup'd by the time this runs.
   */
  escalations: idempotent
    .input(EscalationPayload)
    .mutation(async ({ input, ctx }) => {
      const idem = (
        ctx as Ctx & {
          idempotency: { key: string; deduped: boolean };
        }
      ).idempotency;
      if (idem.deduped) {
        return {
          status: "dedup-skipped" as const,
          key: idem.key,
          ticket: input.ticket,
        };
      }
      // Real handlers would: page operator, open incident, send email.
      // Demo prints to stdout so the wolfdesk run-through is visible.
      console.log(
        `[webhook] ticket=${input.ticket} escalation=${input.escalationId} key=${idem.key}`
      );
      return {
        status: "processed" as const,
        key: idem.key,
        ticket: input.ticket,
      };
    }),
});

export type WebhookRouter = typeof webhookRouter;

/**
 * Start a standalone HTTP server on the configured port. Returned for
 * tests; runs against port 4001 by default when invoked directly.
 */
export function startWebhookReceiver(port = 4001): {
  close: () => Promise<void>;
} {
  const server = createHTTPServer({
    router: webhookRouter,
    createContext: async ({ req }) => {
      // Buffer the raw request body so the receiver middleware can
      // verify the signature against the exact bytes that came over
      // the wire. tRPC's standalone HTTP adapter exposes req as a
      // Node IncomingMessage; we drain it here.
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      return { headers: req.headers, rawBody };
    },
  });
  server.listen(port);
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// Run-from-CLI: `tsx src/webhook-receiver.ts` boots on port 4001.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.WEBHOOK_RECEIVER_PORT) || 4001;
  startWebhookReceiver(port);
  console.log(`[webhook-receiver] listening on http://localhost:${port}`);
}
