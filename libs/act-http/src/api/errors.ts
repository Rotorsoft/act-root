import {
  ConcurrencyError,
  InvariantError,
  NonRetryableError,
  StreamClosedError,
  ValidationError,
} from "@rotorsoft/act";

/**
 * Uniform error envelope shipped over the wire by every act-http
 * transport. Hosts get the same shape from REST, tRPC, and OpenAPI —
 * a client that talks to two transports doesn't have to invent two
 * error parsers.
 *
 * - `error` — the framework error name (`"ValidationError"`,
 *   `"InvariantError"`, …). Stable identifier, safe to switch on.
 * - `detail` — the framework's message text. Human-readable; not
 *   parsed by clients.
 * - `code` — a machine-readable status code from {@link ERROR_MAP}
 *   for clients that prefer enum-style branching over name strings.
 */
export type ApiError = {
  error: string;
  detail?: string;
  code?: string;
};

/**
 * Status + code pair for one known framework error.
 */
export type ErrorMapEntry = {
  status: number;
  code: string;
};

/**
 * The single table that maps framework error types to HTTP status
 * codes and machine-readable codes. One table, three consumers
 * (Hono, tRPC, OpenAPI) — cross-transport consistency by
 * construction.
 *
 * Operators wanting different mappings wrap the generated transport
 * rather than mutating this — the consistency is the load-bearing
 * property, not the specific status codes.
 */
export const ERROR_MAP = {
  ValidationError: { status: 422, code: "VALIDATION" },
  InvariantError: { status: 409, code: "INVARIANT" },
  ConcurrencyError: { status: 412, code: "CONCURRENCY" },
  StreamClosedError: { status: 410, code: "STREAM_CLOSED" },
  NonRetryableError: { status: 400, code: "NON_RETRYABLE" },
} as const satisfies Record<string, ErrorMapEntry>;

const lookupKnown = (err: unknown): { name: keyof typeof ERROR_MAP } | null => {
  if (err instanceof ValidationError) return { name: "ValidationError" };
  if (err instanceof InvariantError) return { name: "InvariantError" };
  if (err instanceof ConcurrencyError) return { name: "ConcurrencyError" };
  if (err instanceof StreamClosedError) return { name: "StreamClosedError" };
  if (err instanceof NonRetryableError) return { name: "NonRetryableError" };
  return null;
};

/**
 * Translate an unknown thrown value into the canonical
 * {@link ApiError} envelope plus HTTP status. Each transport's error
 * boundary calls this once and forwards the result to the wire.
 *
 * Known framework errors map per {@link ERROR_MAP}. Everything else
 * surfaces as a 500 with `code: "INTERNAL"`; the `detail` field is
 * populated when the throw was an `Error` instance, omitted
 * otherwise (a thrown string or object doesn't get to leak its
 * payload to the client).
 */
export function toApiError(err: unknown): { status: number; body: ApiError } {
  const known = lookupKnown(err);
  if (known) {
    const entry = ERROR_MAP[known.name];
    return {
      status: entry.status,
      body: {
        error: known.name,
        detail: (err as Error).message,
        code: entry.code,
      },
    };
  }
  if (err instanceof Error) {
    return {
      status: 500,
      body: { error: "InternalError", detail: err.message, code: "INTERNAL" },
    };
  }
  return {
    status: 500,
    body: { error: "InternalError", code: "INTERNAL" },
  };
}
