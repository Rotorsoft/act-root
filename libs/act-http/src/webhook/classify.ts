/**
 * Three buckets for an HTTP response from an outbound webhook:
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
 * webhook layer means the operator's configured URL is wrong, and
 * retrying the same URL won't fix that. Manual operator review is
 * the right next step, which is what the block path produces.
 */
export type HttpDisposition = "ok" | "retry" | "block";

/**
 * Classify an HTTP response as `ok` (2xx), `retry` (5xx), or
 * `block` (3xx, 4xx). The shape `{@link webhook}` uses internally,
 * lifted here so custom integrations (gRPC bridges, SDK-based
 * reactions, etc.) can apply the same retry semantics without
 * inventing a parallel classification.
 */
export function classifyHttpResponse(response: Response): HttpDisposition {
  if (response.ok) return "ok";
  if (response.status >= 500) return "retry";
  return "block";
}
