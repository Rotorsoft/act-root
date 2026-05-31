import type {
  Receiver,
  ReceiverBuilder,
  ReceiverContext,
  ReceiverOptions,
  Validator,
} from "@rotorsoft/act-ops/receiver";
import { Hono } from "hono";
import { webhookMiddleware } from "./hono/index.js";

/**
 * Recommended factory for "I want to receive webhooks." Returns a
 * {@link ReceiverBuilder} the operator configures fluently:
 *
 * ```ts
 * import { receiver } from "@rotorsoft/act-http/receiver";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 * import { z } from "zod";
 *
 * const r = receiver({
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
 *   })
 *   .build();
 *
 * await r.listen();
 * ```
 *
 * Matches Act's builder pattern: `receiver(...)` is the factory,
 * `.on()` registers handlers fluently, `.build()` finalizes and
 * produces an immutable {@link Receiver} — at which point the type
 * loses `.on()` and gains the runtime methods (`listen` / `close` /
 * `fetch`). The lifecycle phases are split at the type level.
 *
 * Internally uses Hono for routing — the universal-runtime choice
 * that gives one code path coverage across Node, AWS Lambda,
 * Cloudflare Workers, Vercel Edge, Bun, and Deno. For operators
 * with an existing tRPC / Express / Fastify / Hono app who need to
 * compose the receiver with their own middleware stack, the
 * lower-level `webhookMiddleware` from
 * `@rotorsoft/act-http/receiver/<framework>` is the escape hatch.
 *
 * `@hono/node-server` is imported lazily inside `.listen()` so
 * Lambda / edge consumers (who never call `.listen()`) don't need
 * it installed.
 */
export function receiver(options: ReceiverOptions): ReceiverBuilder {
  const app = new Hono<{
    Variables: { idempotency: { key: string; deduped: boolean } };
  }>();

  const middleware = webhookMiddleware({
    store: options.store,
    secret: options.secret,
  });

  let built = false;

  const builder: ReceiverBuilder = {
    on<T>(
      name: string,
      schema: Validator<T>,
      handler: (event: T, ctx: ReceiverContext) => Promise<void>
    ): ReceiverBuilder {
      if (built) {
        throw new Error(
          `Cannot register handler "${name}" after .build() — handlers are frozen once the receiver is built.`
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
            return c.json(
              {
                error: "handler-failed",
                detail: (err as Error).message,
              },
              500
            );
          }
        }

        return c.body(null, 204);
      });

      return builder;
    },

    build(): Receiver {
      built = true;

      // biome-ignore lint/suspicious/noExplicitAny: server lifecycle handle from @hono/node-server
      let server: any | undefined;

      return {
        async listen(): Promise<void> {
          const { serve } = await import("@hono/node-server");
          const launched = serve({ fetch: app.fetch, port: options.port });
          server = launched;
          await new Promise<void>((resolve) => {
            launched.once("listening", () => resolve());
          });
        },

        async close(): Promise<void> {
          if (!server) return;
          const s = server;
          server = undefined;
          await new Promise<void>((resolve) => s.close(() => resolve()));
        },

        async fetch(request: Request): Promise<Response> {
          return app.fetch(request);
        },
      };
    },
  };

  return builder;
}
