import { NonRetryableHttpError, RetryableHttpError } from "./types.js";

/**
 * Three buckets for an HTTP response from an outbound delivery:
 *
 * - `ok` — the receiver accepted the delivery (2xx). Stop and return.
 * - `retry` — the receiver had a transient problem (5xx). Throw a
 *   retryable error; drain will pace the next attempt per `backoff`.
 * - `block` — the receiver rejected the delivery permanently (3xx
 *   or 4xx). Throw a non-retryable error; drain blocks the stream
 *   on the first failed attempt (when `blockOnError` is true) and
 *   surfaces it via the `"blocked"` lifecycle event.
 *
 * The 3xx → `block` mapping is intentional: a redirect at the
 * delivery layer means the configured URL is wrong, and retrying
 * the same URL won't fix that. Manual operator review is the right
 * next step, which is what the block path produces.
 */
export type HttpDisposition = "ok" | "retry" | "block";

/**
 * Classify an HTTP response as `ok` (2xx), `retry` (5xx), or
 * `block` (3xx, 4xx). The classification {@link webhook} uses
 * internally, lifted here so custom integrations (gRPC bridges,
 * SDK-based reactions, etc.) can apply the same retry semantics
 * without inventing a parallel rule.
 */
export function classify_http_response(response: Response): HttpDisposition {
  if (response.ok) return "ok";
  if (response.status >= 500) return "retry";
  return "block";
}

/** Options for {@link try_ok}. */
export type TryOkOptions = {
  /** The endpoint that received the request. Surfaced on the thrown error and in its message. */
  url: string;
  /**
   * Label prefixed onto the error message — typically the
   * integration's identity (`"webhook"`, `"my_sdk"`, `"grpc"`).
   * Default: `"request"`.
   */
  label?: string;
};

/**
 * If `response` is 2xx, return. Otherwise, capture the response body
 * (best-effort) and throw a {@link RetryableHttpError} (for 5xx) or
 * {@link NonRetryableHttpError} (for 3xx/4xx). Collapses the
 * classify-and-throw boilerplate every custom HTTP-like reaction
 * would otherwise write into one line:
 *
 * ```ts
 * .on("OrderConfirmed").do(async (event) => {
 *   const response = await my_sdk.deliver(event);
 *   await try_ok(response, { url: my_sdk.url, label: "my_sdk" });
 *   // ...response was 2xx; continue with downstream work...
 * });
 * ```
 *
 * The {@link webhook} helper throws webhook-specific subclasses
 * ({@link WebhookError} / {@link NonRetryableWebhookError}) for
 * backward compatibility — both extend the generic classes thrown
 * here, so `instanceof RetryableHttpError` matches both webhook and
 * custom-integration errors uniformly.
 */
export async function try_ok(
  response: Response,
  options: TryOkOptions
): Promise<void> {
  const disposition = classify_http_response(response);
  if (disposition === "ok") return;

  let responseBody: string | undefined;
  try {
    responseBody = await response.text();
  } catch {
    // best-effort body capture; ignore read errors
  }

  const label = options.label ?? "request";
  const ErrorClass =
    disposition === "retry" ? RetryableHttpError : NonRetryableHttpError;
  throw new ErrorClass(`${label} ${options.url} responded ${response.status}`, {
    status: response.status,
    url: options.url,
    responseBody,
  });
}
