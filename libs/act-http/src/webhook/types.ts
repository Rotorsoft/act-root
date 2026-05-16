import type { Committed, Schemas } from "@rotorsoft/act";

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
};

/**
 * Error thrown by the webhook handler on network failure, timeout, or
 * non-2xx response. The `status` field is `0` for network / timeout
 * errors and the HTTP status code otherwise.
 *
 * `retryable` reflects the helper's classification: network errors,
 * timeouts, and 5xx are flagged retryable; 4xx is not. The current drain
 * pipeline does not distinguish — both are caught and counted against
 * `maxRetries`. Callers who want different retry semantics per category
 * can introspect the error in a wrapping handler or tune `maxRetries` /
 * `backoff` on the reaction options.
 */
export class WebhookError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly url: string;
  readonly responseBody?: string;

  constructor(
    message: string,
    init: {
      status: number;
      retryable: boolean;
      url: string;
      responseBody?: string;
    }
  ) {
    super(message);
    this.name = "WebhookError";
    this.status = init.status;
    this.retryable = init.retryable;
    this.url = init.url;
    this.responseBody = init.responseBody;
  }
}
