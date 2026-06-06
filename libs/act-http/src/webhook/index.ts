/**
 * @packageDocumentation
 * @module act-http/webhook
 *
 * Reaction-handler sugar for POSTing committed events to external URLs.
 *
 * Wraps `fetch` with timeouts, automatic `Idempotency-Key` derivation, and
 * status-classified errors. Designed to be composed with the reaction
 * options shipped in ACT-601 (`maxRetries`, `blockOnError`, `backoff`):
 *
 * ```ts
 * import { webhook } from "@rotorsoft/act-http/webhook";
 *
 * .on("OrderConfirmed")
 *   .do(
 *     webhook({
 *       url: "https://api.example.com/webhooks/orders",
 *       headers: (e) => ({ Authorization: "Bearer ..." }),
 *       body: (e) => ({ orderId: e.stream, total: e.data.total }),
 *       timeoutMs: 5_000,
 *     }),
 *     { maxRetries: 5, backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000 } }
 *   )
 *   .to(resolver);
 * ```
 */

import type { Committed, ReactionHandler, Schemas } from "@rotorsoft/act";
import { classifyHttpResponse } from "./classify.js";
import { signRequest } from "./sign.js";
import {
  NonRetryableWebhookError,
  type WebhookConfig,
  WebhookError,
} from "./types.js";

export {
  classifyHttpResponse,
  type HttpDisposition,
  type TryOkOptions,
  tryOk,
} from "./classify.js";
export type {
  HttpDeliveryErrorInit,
  WebhookBody,
  WebhookConfig,
  WebhookResolver,
} from "./types.js";
export {
  NonRetryableHttpError,
  NonRetryableWebhookError,
  RetryableHttpError,
  WebhookError,
} from "./types.js";

function resolve<TEvents extends Schemas, T>(
  resolver: T | ((e: Committed<TEvents, keyof TEvents>) => T) | undefined,
  event: Committed<TEvents, keyof TEvents>,
  fallback: T
): T {
  if (resolver === undefined) return fallback;
  return typeof resolver === "function"
    ? (resolver as (e: Committed<TEvents, keyof TEvents>) => T)(event)
    : resolver;
}

/** Case-insensitive lookup; returns true if a header is already set. */
function has_header(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Build a reaction handler that POSTs each event to an external URL.
 *
 * Behavior:
 *
 * - 2xx and 3xx return successfully.
 * - 5xx responses, network errors, and timeouts throw
 *   {@link WebhookError} (`status: 0` for network/timeout). Drain
 *   retries per the reaction's `maxRetries` / `backoff`.
 * - 4xx responses throw {@link NonRetryableWebhookError}, which
 *   extends `NonRetryableError`. The drain finalizer blocks the
 *   stream immediately (when `blockOnError` is true) without
 *   consuming the retry budget.
 */
export function webhook<TEvents extends Schemas = Schemas>(
  config: WebhookConfig<TEvents>
): ReactionHandler<TEvents, keyof TEvents> {
  const timeoutMs = config.timeoutMs ?? 5_000;
  const method = config.method ?? "POST";
  const fetchImpl = config.fetch ?? globalThis.fetch;

  // Named function: slice/act builders require non-anonymous reaction
  // handlers so lifecycle telemetry can attribute work.
  return async function webhookDeliver(event) {
    const url = resolve(config.url, event, "");

    const customHeaders = resolve(
      config.headers,
      event,
      {} as Record<string, string>
    );
    const headers: Record<string, string> = { ...customHeaders };

    if (!has_header(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    if (!has_header(headers, "idempotency-key")) {
      const key = config.idempotencyKey
        ? config.idempotencyKey(event)
        : String(event.id);
      if (key !== null) headers["Idempotency-Key"] = key;
    }

    const rawBody = resolve(config.body, event, event as unknown);
    const body =
      typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);

    if (config.secret && !has_header(headers, "x-webhook-signature")) {
      const { signature, timestamp } = signRequest(body, config.secret);
      headers["X-Webhook-Signature"] = signature;
      if (!has_header(headers, "x-webhook-timestamp")) {
        headers["X-Webhook-Timestamp"] = timestamp;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new WebhookError(
        aborted
          ? `webhook ${method} ${url} timed out after ${timeoutMs}ms`
          : `webhook ${method} ${url} failed: ${(err as Error).message}`,
        { status: 0, url }
      );
    } finally {
      clearTimeout(timer);
    }

    const disposition = classifyHttpResponse(response);
    if (disposition === "ok") return;

    let responseBody: string | undefined;
    try {
      responseBody = await response.text();
    } catch {
      // best-effort body capture; ignore read errors
    }

    const ErrorClass =
      disposition === "retry" ? WebhookError : NonRetryableWebhookError;
    throw new ErrorClass(
      `webhook ${method} ${url} responded ${response.status}`,
      { status: response.status, url, responseBody }
    );
  };
}
