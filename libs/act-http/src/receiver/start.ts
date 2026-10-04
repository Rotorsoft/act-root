import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
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
 *     await process_order(event.orderId, event.total);
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

  // Keys whose winning delivery is still running in this receiver. A
  // duplicate that loses the claim is either behind a committed success
  // (safe to answer 204, "stop retrying") or behind an attempt whose
  // outcome is still unknown. In the second case a 204 would end the
  // sender's retries, and if the original then fails and releases, the
  // delivery is lost. The store can't tell the two apart, so the receiver
  // remembers which claims it won and hasn't finalized yet.
  const in_flight = new Set<string>();
  const middleware = webhookMiddleware({
    store: track_in_flight(options.store, in_flight),
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
        if (idem.deduped && in_flight.has(idem.key)) {
          // The original is still running and may yet fail. Ask the
          // sender to come back instead of telling it to stop: a 5xx is
          // retryable by every sender, including Act's webhook reaction.
          c.header("Retry-After", "1");
          return c.json({ error: "in-flight" }, 503);
        }
        if (!idem.deduped) {
          try {
            await handler(validated, { key: idem.key });
          } catch (err) {
            // Transient failure: release the tentative claim so the
            // sender's retry re-processes instead of being deduped
            // into a silent success and permanently lost. Finalize through
            // the context's `settled`-guarded finalizer, NOT the raw store —
            // the `webhookMiddleware` this route mounts auto-finalizes after
            // `next()` too, and hitting the raw store here double-fires (a
            // stale second `release` can delete a concurrent retry's live
            // claim, breaking exactly-once). The guard collapses both into
            // one store call (#1293).
            await idem.release();
            return c.json(
              {
                error: "handler-failed",
                detail: (err as Error).message,
              },
              500
            );
          }
          // Success: promote the tentative claim to a durable record so every
          // later retry of this key dedups — again via the guarded finalizer,
          // not the raw store (#1293).
          await idem.commit();
        }

        return c.body(null, 204);
      });

      return builder;
    },

    build(): Receiver {
      built = true;

      // `any`: server lifecycle handle from @hono/node-server
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

/**
 * Wraps the idempotency store so every claim this receiver wins is
 * recorded in `in_flight` as it resolves, and dropped only once its
 * commit or release has landed. Marking the key in the claim's own
 * continuation, rather than later in the route, leaves no gap in which a
 * duplicate could lose the claim yet find the key unmarked.
 */
function track_in_flight(
  store: IdempotencyStore,
  in_flight: Set<string>
): IdempotencyStore {
  const mark = (key: string, won: boolean) => {
    if (won) in_flight.add(key);
    return won;
  };
  return {
    claim(key, now) {
      const won = store.claim(key, now);
      return typeof won === "boolean"
        ? mark(key, won)
        : won.then((w) => mark(key, w));
    },
    async commit(key, now) {
      try {
        await store.commit(key, now);
      } finally {
        in_flight.delete(key);
      }
    },
    async release(key) {
      try {
        await store.release(key);
      } finally {
        in_flight.delete(key);
      }
    },
  };
}
