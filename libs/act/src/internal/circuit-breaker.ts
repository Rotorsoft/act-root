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

/**
 * Side-effect hooks the orchestrator wires into the breaker so consumers
 * (drain / settle / autoclose) don't each thread their own callbacks.
 */
export type CircuitBreakerHooks = {
  /** Invoked on every {@link CircuitBreaker.failed} with the error and state. */
  readonly on_error?: (error: unknown, circuit: CircuitState) => void;
  /**
   * Invoked once, `cooldownMs` after the breaker opens (and again on each
   * re-open). The orchestrator wires it to re-attempt a drain — so recovery
   * is automatic even on the default lane, which has no periodic poller.
   */
  readonly on_retry?: () => void;
};

export class CircuitBreaker {
  private _failures = 0;
  private _opened_at: number | undefined;
  private _wake: ReturnType<typeof setTimeout> | undefined;
  private readonly _threshold: number;
  private readonly _cooldown_ms: number;
  private readonly _hooks: CircuitBreakerHooks;

  constructor(config: CircuitBreakerConfig, hooks: CircuitBreakerHooks = {}) {
    this._threshold = config.failureThreshold;
    this._cooldown_ms = config.cooldownMs;
    this._hooks = hooks;
  }

  /** Current state given the wall-clock `now`. */
  state(now: number): CircuitState {
    if (this._opened_at === undefined) return "closed";
    return now - this._opened_at >= this._cooldown_ms ? "half-open" : "open";
  }

  /** A store op passed — reset to closed and cancel any pending retry. */
  passed(): void {
    this._failures = 0;
    this._opened_at = undefined;
    this._clear_wake();
  }

  /**
   * A store op failed. Opens the breaker when the consecutive-failure
   * threshold is reached, or immediately re-opens (restarting the cooldown)
   * if a half-open trial just failed. Returns the resulting state.
   *
   * Callers gate on the state directly — `state(now) === "open"` means skip.
   * On opening, schedules the `on_retry` wake so recovery is automatic;
   * always surfaces the failure via `on_error`.
   */
  failed(now: number, error?: unknown): CircuitState {
    const circuit = this._advance(now);
    if (circuit === "open") this._schedule_wake();
    this._hooks.on_error?.(error, circuit);
    return circuit;
  }

  /** Cancel the pending retry timer. Idempotent; call on shutdown. */
  stop(): void {
    this._clear_wake();
  }

  /**
   * Schedule the `on_retry` wake `cooldownMs` out so the breaker re-trials
   * the store on its own. No-op when no `on_retry` hook is wired (e.g. unit
   * tests of the pure state machine). The timer is `unref`'d so it never
   * keeps the process alive.
   */
  private _schedule_wake(): void {
    if (!this._hooks.on_retry) return;
    this._clear_wake();
    this._wake = setTimeout(() => {
      this._wake = undefined;
      this._hooks.on_retry?.();
    }, this._cooldown_ms);
    this._wake.unref();
  }

  private _clear_wake(): void {
    if (this._wake) {
      clearTimeout(this._wake);
      this._wake = undefined;
    }
  }

  /** Pure state transition for a failure — no side effects. */
  private _advance(now: number): CircuitState {
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
