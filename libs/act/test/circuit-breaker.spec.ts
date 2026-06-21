import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/internal/circuit-breaker.js";

describe("CircuitBreaker", () => {
  const make = () =>
    new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });

  it("starts closed and allows attempts", () => {
    const cb = make();
    expect(cb.state(0)).toBe("closed");
    expect(cb.can_attempt(0)).toBe(true);
  });

  it("stays closed until the failure threshold is reached", () => {
    const cb = make();
    expect(cb.record_failure(0)).toBe("closed");
    expect(cb.record_failure(0)).toBe("closed");
    expect(cb.record_failure(0)).toBe("open"); // 3rd consecutive
    expect(cb.can_attempt(0)).toBe(false);
  });

  it("a success resets the failure count", () => {
    const cb = make();
    cb.record_failure(0);
    cb.record_failure(0);
    cb.record_success();
    expect(cb.record_failure(0)).toBe("closed"); // count restarted
  });

  it("transitions open → half-open after the cooldown", () => {
    const cb = make();
    cb.record_failure(0);
    cb.record_failure(0);
    cb.record_failure(0); // open at t=0
    expect(cb.state(999)).toBe("open");
    expect(cb.can_attempt(999)).toBe(false);
    expect(cb.state(1000)).toBe("half-open");
    expect(cb.can_attempt(1000)).toBe(true);
  });

  it("a half-open trial that fails re-opens and restarts the cooldown", () => {
    const cb = make();
    cb.record_failure(0);
    cb.record_failure(0);
    cb.record_failure(0); // open at t=0
    // cooldown elapsed → half-open trial fails at t=1000
    expect(cb.record_failure(1000)).toBe("open");
    expect(cb.state(1999)).toBe("open"); // cooldown restarted from 1000
    expect(cb.state(2000)).toBe("half-open");
  });

  it("a half-open trial that succeeds closes the breaker", () => {
    const cb = make();
    cb.record_failure(0);
    cb.record_failure(0);
    cb.record_failure(0); // open
    expect(cb.state(1000)).toBe("half-open");
    cb.record_success();
    expect(cb.state(1000)).toBe("closed");
    expect(cb.can_attempt(1000)).toBe(true);
  });
});
