/**
 * @module act-ops/idempotency/min-safe-ttl
 *
 * Internal math for sizing the dedup window of an
 * {@link IdempotencyStore} from a sender's retry profile.
 *
 * **Not re-exported from the package root** by design — the math is
 * an implementation detail of {@link InMemoryIdempotencyStore} (and
 * any future durable adapter). Operators configure dedup windows
 * through the store's `retryProfile` option, not by calling this
 * function directly. Tests import it from this path; external
 * consumers can't reach it.
 */

/**
 * A sender's retry behaviour, described in enough detail to size a
 * receiver-side dedup window correctly. The `backoff` shape is typed
 * inline structurally so it's assignable from `@rotorsoft/act`'s
 * `BackoffOptions` without this package importing the framework
 * (the zero-act-dep load-bearing constraint of `@rotorsoft/act-ops`).
 * A caller holding `act.BackoffOptions` can pass it as `backoff`
 * with no cast — TypeScript treats the two shapes as equivalent.
 *
 * @property maxRetries - Retries after the first attempt fails
 * @property backoff - Optional backoff strategy. When omitted,
 *   retries fire back-to-back with only the per-attempt timeout
 *   between them
 * @property timeoutMs - Per-attempt timeout (the sender's `fetch`
 *   timeout, or the equivalent for whatever transport)
 * @property safetyFactor - Multiplier applied to the bare envelope.
 *   Default 4
 */
export type RetryProfile = {
  readonly maxRetries: number;
  readonly backoff?: {
    readonly strategy: "fixed" | "linear" | "exponential";
    readonly baseMs: number;
    readonly maxMs?: number;
    readonly jitter?: boolean;
  };
  readonly timeoutMs: number;
  readonly safetyFactor?: number;
};

/**
 * Minimum safe TTL in milliseconds for a receiver-side
 * {@link IdempotencyStore} window, given the sender's retry profile.
 *
 * The envelope is:
 *
 *     ttl = (backoffSum + (maxRetries + 1) * timeoutMs) * safetyFactor
 *
 * where `backoffSum` is the sum of per-retry delays from the chosen
 * `strategy`, multiplied by 1.5 if `jitter` is enabled (the
 * worst-case multiplier in `[0.5, 1.5)`). `safetyFactor` defaults
 * to 4 because operators almost always want headroom over the bare
 * envelope — slow networks, clock skew, and incident-window retries
 * stretch the real-world maximum past the computed one.
 */
export function minSafeTtl(profile: RetryProfile): number {
  const safetyFactor = profile.safetyFactor ?? 4;
  const backoffSum = sum_backoff(profile.maxRetries, profile.backoff);
  const timeoutSum = (profile.maxRetries + 1) * profile.timeoutMs;
  return (backoffSum + timeoutSum) * safetyFactor;
}

function sum_backoff(
  maxRetries: number,
  backoff: RetryProfile["backoff"]
): number {
  if (!backoff) return 0;
  let sum = 0;
  for (let retry = 0; retry < maxRetries; retry++) {
    sum += delay_for(retry, backoff);
  }
  return backoff.jitter ? sum * 1.5 : sum;
}

function delay_for(
  retry: number,
  backoff: NonNullable<RetryProfile["backoff"]>
): number {
  switch (backoff.strategy) {
    case "fixed":
      return backoff.baseMs;
    case "linear":
      return backoff.baseMs * (retry + 1);
    case "exponential": {
      const raw = backoff.baseMs * 2 ** retry;
      return backoff.maxMs !== undefined ? Math.min(raw, backoff.maxMs) : raw;
    }
  }
}
