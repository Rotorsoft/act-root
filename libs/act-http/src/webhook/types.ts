import {
  type Committed,
  NonRetryableError,
  type Schemas,
} from "@rotorsoft/act";

/**
 * Function or static value resolver. Used so callers can pass either a
 * constant or a per-event function for headers / body / url.
 *
 * The static side `T` is constrained to non-function types so that a
 * passed `(event) => ...` is unambiguously typed as the function variant.
 */
export type WebhookResolver<TEvents extends Schemas, T> =
  | T
  | ((event: Committed<TEvents, keyof TEvents>) => T);

/**
 * Plain-data body shape the helper accepts as a static value. Functions
 * are deliberately excluded so the union with the resolver function is
 * unambiguous at the call site (TypeScript can discriminate by shape).
 */
export type WebhookBody =
  | string
  | { readonly [k: string]: unknown }
  | readonly unknown[];

/**
 * Configuration for {@link webhook}.
 *
 * @template TEvents - Event schemas; resolvers receive the typed committed event.
 */
export type WebhookConfig<TEvents extends Schemas = Schemas> = {
  /** Target URL — static string or per-event function. */
  readonly url: WebhookResolver<TEvents, string>;
  /** HTTP method. Defaults to `"POST"`. */
  readonly method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Headers to send. Resolver may return a record per event. The
   * `Content-Type: application/json` and `Idempotency-Key` headers are
   * applied automatically; both can be overridden by returning a header
   * with the same name (case-insensitive).
   */
  readonly headers?: WebhookResolver<TEvents, Record<string, string>>;
  /**
   * Request body. Static plain data (object, array, string) or a
   * per-event function returning the same. Strings are sent as-is;
   * anything else is JSON-serialized. Defaults to the committed event
   * itself.
   */
  readonly body?:
    | WebhookBody
    | ((event: Committed<TEvents, keyof TEvents>) => WebhookBody);
  /**
   * Per-request timeout in milliseconds. Defaults to 5000.
   * The handler throws after the timeout via `AbortController`.
   */
  readonly timeout_ms?: number;
  /**
   * Override for the auto-generated `Idempotency-Key`. By default, the
   * helper sends `event.id` (the immutable, monotonic event identifier).
   * Return a string to override; return `null` to skip the header entirely.
   */
  readonly idempotency_key?: (
    event: Committed<TEvents, keyof TEvents>
  ) => string | null;
  /**
   * Injection point for tests. Defaults to global `fetch`.
   */
  readonly fetch?: typeof fetch;
  /**
   * HMAC-SHA256 signing key. When set, the webhook helper attaches
   * two headers to every request:
   *
   * - `X-Webhook-Signature: sha256=<hex>` — HMAC of
   *   `${timestamp}.${body}` (`body` is the final serialized payload)
   * - `X-Webhook-Timestamp: <unix-seconds>`
   *
   * Pair with `verify_webhook` from `@rotorsoft/act-http/receiver` on
   * the receiving side. When undefined, no signature headers are
   * added — back-compat with consumers that don't need signing.
   *
   * Callers can override either header by returning it from the
   * `headers` resolver (case-insensitive), the same way the
   * `Idempotency-Key` and `Content-Type` defaults yield to caller
   * intent.
   */
  readonly secret?: string;
};

/**
 * Common fields carried on every HTTP delivery error in this package.
 */
export type HttpDeliveryErrorInit = {
  status: number;
  url: string;
  response_body?: string;
};

/**
 * Thrown when an HTTP delivery fails in a way the drain pipeline
 * should retry: network failure, timeout, or 5xx response. `status` is
 * `0` for network / timeout errors, the HTTP status code otherwise.
 *
 * The class itself is the retry signal — if a reaction throws this,
 * drain treats it like any other error (counts against `maxRetries`,
 * paces with `backoff`). For permanent failures, throw
 * {@link NonRetryableHttpError} instead.
 *
 * Generic enough to cover any custom HTTP-like integration (gRPC
 * bridges, SDK-based reactions). {@link WebhookError} is a
 * webhook-specific subclass kept for backward compatibility.
 */
export class RetryableHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly response_body?: string;

  constructor(message: string, init: HttpDeliveryErrorInit) {
    super(message);
    this.name = "RetryableHttpError";
    this.status = init.status;
    this.url = init.url;
    this.response_body = init.response_body;
  }
}

/**
 * Thrown when an HTTP delivery returns a 3xx or 4xx response —
 * permanent client errors that won't recover on retry. Extends
 * {@link NonRetryableError} so the drain finalizer blocks the stream
 * on the first failed attempt (when `blockOnError` is true) — no
 * wasted retries on a malformed payload or wrong URL.
 *
 * Generic enough to cover any custom HTTP-like integration.
 * {@link NonRetryableWebhookError} is a webhook-specific subclass kept
 * for backward compatibility.
 */
export class NonRetryableHttpError extends NonRetryableError {
  readonly status: number;
  readonly url: string;
  readonly response_body?: string;

  constructor(message: string, init: HttpDeliveryErrorInit) {
    super(message);
    this.name = "NonRetryableHttpError";
    this.status = init.status;
    this.url = init.url;
    this.response_body = init.response_body;
  }
}

/**
 * Webhook-specific subclass of {@link RetryableHttpError}. Thrown by
 * the {@link webhook} helper on 5xx responses, network failures, and
 * timeouts. Existing `instanceof WebhookError` checks continue to
 * work; new code targeting the generic HTTP integration shape can
 * catch {@link RetryableHttpError} instead and handle webhook +
 * custom integrations uniformly.
 */
export class WebhookError extends RetryableHttpError {
  constructor(message: string, init: HttpDeliveryErrorInit) {
    super(message, init);
    this.name = "WebhookError";
  }
}

/**
 * Webhook-specific subclass of {@link NonRetryableHttpError}. Thrown
 * by the {@link webhook} helper on 3xx/4xx responses. Existing
 * `instanceof NonRetryableWebhookError` checks continue to work; new
 * code can catch {@link NonRetryableHttpError} or
 * {@link NonRetryableError} for broader coverage.
 */
export class NonRetryableWebhookError extends NonRetryableHttpError {
  constructor(message: string, init: HttpDeliveryErrorInit) {
    super(message, init);
    this.name = "NonRetryableWebhookError";
  }
}
