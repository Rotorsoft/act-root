import type {
  Validator,
  WebhookContext,
  WebhookReceiver,
  WebhookReceiverOptions,
} from "@rotorsoft/act-ops/webhook";
import { Hono } from "hono";
import { webhookMiddleware } from "./hono/index.js";

/**
 * Recommended path for "I want to receive webhooks." Returns a
 * {@link WebhookReceiver} the operator configures fluently and
 * starts with `.listen()` (long-running Node server) or
 * `.fetch(request)` (Lambda / Cloudflare Workers / Vercel Edge /
 * Bun / Deno — any fetch-shaped runtime).
 *
 * Internally uses Hono for routing — the universal-runtime choice
 * that gives one code path coverage across every deployment target.
 * For operators with an existing tRPC / Express / Fastify / Hono app
 * who need to compose the receiver with their own middleware stack,
 * the lower-level `webhookMiddleware` from
 * `@rotorsoft/act-http/receiver/<framework>` is the escape hatch.
 *
 * `@hono/node-server` is imported lazily inside `.listen()` so
 * Lambda / edge consumers (who never call `.listen()`) don't need
 * it installed.
 *
 * @example
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
 *   .on("OrderConfirmed", z.object({
 *     orderId: z.string(),
 *     total: z.number(),
 *   }), async (event, ctx) => {
 *     // event.orderId and event.total are typed
 *     // ctx.key is the deduplicated Idempotency-Key
 *     await processOrder(event.orderId, event.total);
 *   });
 *
 * await receiver.listen();
 * ```
 */
export function webhookReceiver(
  options: WebhookReceiverOptions
): WebhookReceiver {
  const app = new Hono<{
    Variables: { idempotency: { key: string; deduped: boolean } };
  }>();

  const middleware = webhookMiddleware({
    store: options.store,
    secret: options.secret,
  });

  // biome-ignore lint/suspicious/noExplicitAny: server lifecycle handle from @hono/node-server
  let server: any | undefined;
  let listening = false;

  const receiver: WebhookReceiver = {
    on<T>(
      name: string,
      schema: Validator<T>,
      handler: (event: T, ctx: WebhookContext) => Promise<void>
    ): WebhookReceiver {
      if (listening) {
        throw new Error(
          `Cannot register handler "${name}" after listen() — handlers are frozen once the receiver starts serving.`
        );
      }

      app.post(`/${name}`, middleware, async (c) => {
        let validated: T;
        try {
          const body = await c.req.json();
          validated = schema.parse(body);
        } catch (err) {
          return c.json(
            {
              error: "validation-failed",
              detail: (err as Error).message,
            },
            422
          );
        }

        const idem = c.get("idempotency");
        if (!idem.deduped) {
          try {
            await handler(validated, { key: idem.key });
          } catch (err) {
            // Handler threw — surface as 500 so the sender retries.
            // The handler's exception is the sender's signal that
            // delivery hasn't succeeded yet.
            return c.json(
              {
                error: "handler-failed",
                detail: (err as Error).message,
              },
              500
            );
          }
        }

        // 204 No Content for both successful first-time processing
        // and dedup-skipped replays — the sender treats both as
        // "accepted; stop retrying."
        return c.body(null, 204);
      });

      return receiver;
    },

    async listen(): Promise<void> {
      // Lazy-load @hono/node-server so Lambda / edge consumers that
      // only call .fetch() don't need it installed.
      const { serve } = await import("@hono/node-server");
      listening = true;
      const launched = serve({ fetch: app.fetch, port: options.port });
      server = launched;
      // Wait for the server to be bound to its port.
      await new Promise<void>((resolve) => {
        launched.once("listening", () => resolve());
      });
    },

    async close(): Promise<void> {
      if (!server) return;
      const s = server;
      server = undefined;
      listening = false;
      // server.close() always invokes the callback; we resolve
      // unconditionally — a close error here would already have
      // surfaced via the server's "error" event upstream.
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },

    async fetch(request: Request): Promise<Response> {
      return app.fetch(request);
    },
  };

  return receiver;
}
