/**
 * Standalone webhook receiver demonstrating the receiver-side
 * idempotency contract. Pair with the wolfdesk sender by setting:
 *   WOLFDESK_ESCALATION_WEBHOOK=http://localhost:4001/escalations
 *
 * The handler distinguishes fresh requests from duplicates so operators
 * can confirm dedup is working — first delivery returns
 * `{ status: "processed" }`, retries return `{ status: "dedup-skipped" }`.
 *
 * The middleware is composed inline against the local `t.procedure` so
 * tRPC's generic inference can flow `key` and `deduped` into downstream
 * handlers without manual `as` casts.
 */

import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops";
import { initTRPC, TRPCError } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { z } from "zod";
import { extractIdempotencyKey } from "./idempotency.js";

/** tRPC context shape: just the raw request headers. */
type Ctx = { headers: Record<string, string | string[] | undefined> };

const t = initTRPC.context<Ctx>().create();

const dedup = new InMemoryIdempotencyStore({
  // 24h dedup window — covers any reasonable retry+backoff envelope
  // from a sender using ACT-601 `exponential` backoff up to maxMs=30s.
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 50_000,
});

/**
 * The idempotency middleware. Refuses requests without an
 * `Idempotency-Key`; injects `{ key, deduped }` into context so the
 * downstream handler can short-circuit duplicates without re-executing
 * its side effect.
 */
const idempotent = t.procedure.use(({ ctx, next }) => {
  const key = extractIdempotencyKey(ctx.headers);
  if (!key) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing Idempotency-Key header",
    });
  }
  const deduped = !dedup.record_if_fresh(key);
  return next({ ctx: { ...ctx, key, deduped } });
});

const EscalationPayload = z.object({
  ticket: z.string(),
  escalationId: z.string(),
});

export const webhookRouter = t.router({
  /**
   * Inbound webhook for ticket escalations. Idempotent: a re-sent
   * request with the same `Idempotency-Key` returns a `deduped` marker
   * without re-executing side effects.
   */
  escalations: idempotent
    .input(EscalationPayload)
    .mutation(async ({ input, ctx }) => {
      if (ctx.deduped) {
        return {
          status: "dedup-skipped" as const,
          key: ctx.key,
          ticket: input.ticket,
        };
      }
      // Real handlers would: page operator, open incident, send email.
      // Demo prints to stdout so the wolfdesk run-through is visible.
      console.log(
        `[webhook] ticket=${input.ticket} escalation=${input.escalationId} key=${ctx.key}`
      );
      return {
        status: "processed" as const,
        key: ctx.key,
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
    createContext: ({ req }) => ({ headers: req.headers }),
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
