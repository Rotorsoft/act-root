/**
 * @module internal/circuit-breaker
 *
 * Orchestrator-level circuit breaker for store operations. The drain loop
 * polls `claim()` continuously; when the backing store goes down every poll
 * throws a {@link StoreError}, and without a breaker the orchestrator would
 * spin at the cycle cadence hammering a dead database and flooding the logs.
 *
 * The breaker collapses that into three states:
 *
 * - **closed** — normal operation; failures are counted.
 * - **open** — `failureThreshold` consecutive failures tripped it; attempts
 *   are skipped for `cooldownMs` so the store gets room to recover.
 * - **half-open** — the cooldown elapsed; a single trial attempt is allowed.
 *   Success closes the breaker; failure re-opens it and restarts the clock.
 *
 * Time is passed in (`now`) rather than read from the clock so the state
 * machine is deterministic under test.
 */

import { z } from "zod";

/** Circuit breaker state. */
export type CircuitState = "closed" | "open" | "half-open";

/** Resolved circuit-breaker configuration. */
export type CircuitBreakerConfig = {
  /** Consecutive store failures that trip the breaker open. */
  readonly failureThreshold: number;
  /** Milliseconds the breaker stays open before allowing a half-open trial. */
  readonly cooldownMs: number;
};

export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

const CircuitBreakerOptionsSchema = z.object({
  failureThreshold: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_CIRCUIT_FAILURE_THRESHOLD),
  cooldownMs: z
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .default(DEFAULT_CIRCUIT_COOLDOWN_MS),
});

/** Public, all-optional circuit-breaker options bag for `act().build()`. */
export type CircuitBreakerOptions = z.input<typeof CircuitBreakerOptionsSchema>;

/** Parse + apply defaults. Throws `ZodError` on out-of-range values. */
export const resolveCircuitBreakerConfig = (
  options?: CircuitBreakerOptions
): CircuitBreakerConfig => CircuitBreakerOptionsSchema.parse(options ?? {});

export class CircuitBreaker {
  private _failures = 0;
  private _opened_at: number | undefined;
  private readonly _threshold: number;
  private readonly _cooldown_ms: number;

  constructor(config: CircuitBreakerConfig) {
    this._threshold = config.failureThreshold;
    this._cooldown_ms = config.cooldownMs;
  }

  /** Current state given the wall-clock `now`. */
  state(now: number): CircuitState {
    if (this._opened_at === undefined) return "closed";
    return now - this._opened_at >= this._cooldown_ms ? "half-open" : "open";
  }

  /** Whether an attempt is allowed now (closed or a half-open trial). */
  can_attempt(now: number): boolean {
    return this.state(now) !== "open";
  }

  /** A store op succeeded — reset to closed. */
  record_success(): void {
    this._failures = 0;
    this._opened_at = undefined;
  }

  /**
   * A store op failed. Opens the breaker when the consecutive-failure
   * threshold is reached, or immediately re-opens (restarting the cooldown)
   * if a half-open trial just failed. Returns the resulting state.
   */
  record_failure(now: number): CircuitState {
    // Already tripped: this can only be reached from a half-open trial
    // (open skips attempts), so the trial failed — re-open and restart.
    if (this._opened_at !== undefined) {
      this._opened_at = now;
      return "open";
    }
    this._failures += 1;
    if (this._failures >= this._threshold) {
      this._opened_at = now;
      return "open";
    }
    return "closed";
  }
}
