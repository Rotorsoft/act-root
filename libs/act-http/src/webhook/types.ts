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
  readonly timeoutMs?: number;
  /**
   * Override for the auto-generated `Idempotency-Key`. By default, the
   * helper sends `event.id` (the immutable, monotonic event identifier).
   * Return a string to override; return `null` to skip the header entirely.
   */
  readonly idempotencyKey?: (
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
   * Pair with `verifyWebhook` from `@rotorsoft/act-http/receiver` on
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
 * Common fields carried on both webhook error subclasses.
 */
type WebhookErrorInit = {
  status: number;
  url: string;
  responseBody?: string;
};

/**
 * Thrown when a webhook request fails in a way the drain pipeline
 * should retry: network failure, timeout, or 5xx response. `status` is
 * `0` for network / timeout errors, the HTTP status code otherwise.
 *
 * The class itself is the retry signal — if the helper throws this,
 * drain treats it like any other error (counts against `maxRetries`,
 * paces with `backoff`). For permanent failures, the helper throws
 * {@link NonRetryableWebhookError} instead.
 */
export class WebhookError extends Error {
  readonly status: number;
  readonly url: string;
  readonly responseBody?: string;

  constructor(message: string, init: WebhookErrorInit) {
    super(message);
    this.name = "WebhookError";
    this.status = init.status;
    this.url = init.url;
    this.responseBody = init.responseBody;
  }
}

/**
 * Thrown when a webhook returns a 4xx response. Extends
 * {@link NonRetryableError} so the drain finalizer blocks the stream on
 * the first failed attempt (when `blockOnError` is true) — no wasted
 * retries on permanent client errors.
 *
 * Carries the same `status` / `url` / `responseBody` fields as
 * {@link WebhookError}; not a subclass of it (a single instance can't
 * be both `WebhookError` and `NonRetryableError`). Callers catching
 * either retryable or non-retryable webhook failures should check both
 * classes, or check the shared fields directly.
 */
export class NonRetryableWebhookError extends NonRetryableError {
  readonly status: number;
  readonly url: string;
  readonly responseBody?: string;

  constructor(message: string, init: WebhookErrorInit) {
    super(message);
    this.name = "NonRetryableWebhookError";
    this.status = init.status;
    this.url = init.url;
    this.responseBody = init.responseBody;
  }
}
