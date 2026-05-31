import type { IdempotencyStore } from "../idempotency/port.js";

/**
 * Context passed to every handler after the receiver has verified
 * the inbound request (when configured) and claimed the
 * `Idempotency-Key` (or the transport's native message identifier)
 * on the configured store.
 */
export type ReceiverContext = {
  /** The deduplicated identity of the inbound event. */
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
 * Generic inbound-receiver port — the runtime artifact produced by
 * {@link ReceiverBuilder.build}. Transport-agnostic: the same shape
 * fits HTTP webhooks, message-bus consumers (Kafka/SQS/NATS/Rabbit),
 * CDC streams, WebSocket subscribers, scheduled pollers, and any
 * other "external events arrive into this Act app" pattern.
 *
 * Adapters in `@rotorsoft/act-http/receiver` implement the HTTP
 * flavor today; bus consumers and other transport adapters
 * implement the same port in their own packages without redesigning
 * the contract.
 *
 * Two deployment modes:
 *
 * - **Long-running server** — {@link listen} binds to a port (HTTP),
 *   a topic (bus), a path (WebSocket), etc.
 * - **Request-response (Lambda / edge / serverless)** —
 *   {@link fetch} handles one request and returns the response.
 *   Available on the HTTP adapter; bus consumers and other
 *   non-fetch transports throw.
 */
export type Receiver = {
  /**
   * Bind and start accepting inbound events. Resolves once the
   * transport is ready (server listening, consumer subscribed, etc.).
   */
  listen(): Promise<void>;
  /**
   * Stop gracefully. Resolves when the transport has shut down.
   * No-op if never started.
   */
  close(): Promise<void>;
  /**
   * Handle a single fetch-shaped request. Available on the HTTP
   * adapter for Lambda / Cloudflare Workers / Vercel Edge / Bun /
   * Deno. Bus consumers and other non-fetch transports throw.
   */
  fetch(request: Request): Promise<Response>;
};

/**
 * Fluent builder for a {@link Receiver}. Matches Act's builder
 * pattern: factories return a builder, builder methods register
 * configuration, `.build()` finalizes and produces the immutable
 * runtime artifact.
 *
 * The type-level split between builder (`on`, `build`) and receiver
 * (`listen`, `close`, `fetch`) means operators can't accidentally
 * call `.on()` on a running receiver — registration and runtime
 * are different lifecycle phases enforced at compile time.
 */
export type ReceiverBuilder = {
  /**
   * Register a typed handler for a named event. The receiver
   * validates the inbound body (or the transport's payload shape)
   * with `schema` before calling `handler` — so the handler sees a
   * fully-typed event, never raw bytes. Returns `this` for fluent
   * chaining.
   *
   * For the HTTP adapter, handlers are mounted at `POST /<name>`.
   * Bus adapters dispatch based on a topic-encoded name; the
   * convention is per-transport.
   */
  on<T>(
    name: string,
    schema: Validator<T>,
    handler: (event: T, ctx: ReceiverContext) => Promise<void>
  ): ReceiverBuilder;
  /**
   * Finalize the configuration and produce the runtime
   * {@link Receiver}. After `.build()`, no more handlers can be
   * registered.
   */
  build(): Receiver;
};

/**
 * Options for HTTP {@link Receiver} adapters. Transport-specific
 * adapters (bus consumers, WebSocket subscribers) define their own
 * options types — only the {@link Receiver} port and the
 * {@link ReceiverBuilder} contract stay the same across transports.
 */
export type ReceiverOptions = {
  /**
   * Port to bind when calling {@link Receiver.listen}. Ignored when
   * the receiver is used in fetch-style mode (Lambda / edge).
   */
  readonly port: number;
  /**
   * Idempotency store the receiver claims keys on. Match the
   * sender's retry envelope when sizing.
   * `InMemoryIdempotencyStore` from
   * `@rotorsoft/act-ops/idempotency` is the default single-process
   * choice.
   */
  readonly store: IdempotencyStore;
  /**
   * HMAC-SHA256 shared secret. When set, the HTTP adapter verifies
   * the `X-Webhook-Signature` and `X-Webhook-Timestamp` headers
   * against the raw request body. Pair with `webhook({ secret })`
   * on the sender side. When undefined, signature verification is
   * skipped.
   *
   * Transport-specific adapters interpret this field according to
   * their own authentication model.
   */
  readonly secret?: string;
};
