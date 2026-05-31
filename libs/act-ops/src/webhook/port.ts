import type { IdempotencyStore } from "../idempotency/port.js";

/**
 * Context passed to every webhook handler after the receiver has
 * verified the signature (when configured) and claimed the
 * `Idempotency-Key` on the configured store.
 */
export type WebhookContext = {
  /** The deduplicated `Idempotency-Key` value from the inbound request. */
  readonly key: string;
};

/**
 * Zod-compatible schema shape, typed structurally so this package
 * doesn't import Zod directly. Any `z.object(...)` (or anything with
 * a `parse(input): T` method) satisfies the shape.
 */
export type Validator<T> = {
  parse(input: unknown): T;
};

/**
 * Receiver-side high-level port. Adapters in
 * `@rotorsoft/act-http/receiver/<framework>` implement this; the
 * operator never sees a framework object directly.
 *
 * Register typed handlers fluently:
 *
 * ```ts
 * const receiver = webhookReceiver({ port: 4001, store, secret })
 *   .on("OrderConfirmed", OrderConfirmedSchema, async (event, ctx) => {
 *     // `event` is typed as the schema's output; `ctx.key` is the dedup key
 *   })
 *   .on("OrderShipped", OrderShippedSchema, async (event, ctx) => {
 *     // …
 *   });
 *
 * await receiver.listen();
 * ```
 *
 * Two deployment modes:
 *
 * - **Long-running server** — `listen()` binds to the configured
 *   port. Works on every adapter (Express, Fastify, Hono, tRPC).
 * - **Request-response (Lambda / edge / serverless)** — `fetch(request)`
 *   handles one request and returns the response. Available on the
 *   **Hono adapter** out of the box (Hono is fetch-style natively,
 *   with first-class deployment targets for AWS Lambda, Cloudflare
 *   Workers, Vercel Edge, Bun, Deno). Other adapters throw.
 */
export type WebhookReceiver = {
  /**
   * Register a typed handler for a named event. The receiver
   * validates the inbound body with `schema` before calling
   * `handler` — so the handler sees a fully-typed event, never a
   * raw body. Returns `this` for fluent chaining.
   *
   * Handlers are mounted at `POST /<name>` by the framework adapter.
   * Registering the same name twice replaces the prior handler;
   * calling `.on()` after `.listen()` throws (handlers are frozen
   * once serving).
   */
  on<T>(
    name: string,
    schema: Validator<T>,
    handler: (event: T, ctx: WebhookContext) => Promise<void>
  ): WebhookReceiver;
  /**
   * Bind to the configured port and start accepting requests.
   * Resolves once the server is listening. Use for long-running
   * Node deployments.
   */
  listen(): Promise<void>;
  /**
   * Stop gracefully. Resolves when the server has closed. No-op if
   * never listening.
   */
  close(): Promise<void>;
  /**
   * Handle a single fetch-shaped request. Use this directly inside
   * a Lambda handler, an edge function, or any other request-
   * response runtime. Only the Hono adapter implements this; other
   * adapters throw `"fetch not supported on this adapter — pick the
   * Hono adapter for edge/serverless deployment"`.
   */
  fetch(request: Request): Promise<Response>;
};

/**
 * Options for {@link WebhookReceiver} adapters. Identical across
 * every framework — the operator declares port, store, optional
 * secret, and the chosen adapter does everything else.
 *
 * Handlers are registered via `.on(name, schema, handler)` on the
 * returned receiver, not in this options bag — fluent registration
 * preserves per-handler typing through the generic on `.on()`.
 */
export type WebhookReceiverOptions = {
  /**
   * Port to bind when calling {@link WebhookReceiver.listen}. Ignored
   * when the receiver is used in fetch-style mode (Lambda / edge).
   */
  readonly port: number;
  /**
   * Idempotency store the receiver claims keys on. Match the
   * sender's retry envelope when sizing;
   * `InMemoryIdempotencyStore` from
   * `@rotorsoft/act-ops/idempotency` is the default single-process
   * choice.
   */
  readonly store: IdempotencyStore;
  /**
   * HMAC-SHA256 shared secret. When set, the receiver verifies the
   * `X-Webhook-Signature` and `X-Webhook-Timestamp` headers against
   * the raw request body. Pair with `webhook({ secret })` on the
   * sender side. When undefined, signature verification is skipped.
   */
  readonly secret?: string;
};
