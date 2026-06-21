import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/internal/circuit-breaker.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CircuitBreaker", () => {
  const make = () =>
    new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });

  it("starts closed", () => {
    expect(make().state(0)).toBe("closed");
  });

  it("stays closed until the failure threshold is reached", () => {
    const cb = make();
    expect(cb.failed(0)).toBe("closed");
    expect(cb.failed(0)).toBe("closed");
    expect(cb.failed(0)).toBe("open"); // 3rd consecutive trips it
    expect(cb.state(0)).toBe("open");
  });

  it("a pass resets the failure count", () => {
    const cb = make();
    cb.failed(0);
    cb.failed(0);
    cb.passed();
    expect(cb.failed(0)).toBe("closed"); // count restarted
  });

  it("transitions open → half-open after the cooldown", () => {
    const cb = make();
    cb.failed(0);
    cb.failed(0);
    cb.failed(0); // open at t=0
    expect(cb.state(999)).toBe("open");
    expect(cb.state(1000)).toBe("half-open");
  });

  it("a half-open trial that fails re-opens and restarts the cooldown", () => {
    const cb = make();
    cb.failed(0);
    cb.failed(0);
    cb.failed(0); // open at t=0
    // cooldown elapsed → half-open trial fails at t=1000
    expect(cb.failed(1000)).toBe("open");
    expect(cb.state(1999)).toBe("open"); // cooldown restarted from 1000
    expect(cb.state(2000)).toBe("half-open");
  });

  it("a half-open trial that passes closes the breaker", () => {
    const cb = make();
    cb.failed(0);
    cb.failed(0);
    cb.failed(0); // open
    expect(cb.state(1000)).toBe("half-open");
    cb.passed();
    expect(cb.state(1000)).toBe("closed");
  });

  it("invokes the on_error hook on each failure with the resulting state", () => {
    const seen: { error: unknown; circuit: string }[] = [];
    const cb = new CircuitBreaker(
      { failureThreshold: 1, cooldownMs: 1000 },
      { on_error: (error, circuit) => seen.push({ error, circuit }) }
    );
    const err = new Error("boom");
    cb.failed(0, err);
    expect(seen).toEqual([{ error: err, circuit: "open" }]);
  });

  it("fires the on_retry hook cooldownMs after it opens", () => {
    vi.useFakeTimers();
    let retries = 0;
    const cb = new CircuitBreaker(
      { failureThreshold: 1, cooldownMs: 1000 },
      { on_retry: () => retries++ }
    );
    cb.failed(0); // opens → schedules the wake
    expect(retries).toBe(0);
    vi.advanceTimersByTime(999);
    expect(retries).toBe(0);
    vi.advanceTimersByTime(1); // cooldown elapsed
    expect(retries).toBe(1);
  });

  it("cancels the pending retry when it closes or stops", () => {
    vi.useFakeTimers();
    let retries = 0;
    const cb = new CircuitBreaker(
      { failureThreshold: 1, cooldownMs: 1000 },
      { on_retry: () => retries++ }
    );
    cb.failed(0); // schedules a wake
    cb.passed(); // closes → cancels it
    vi.advanceTimersByTime(2000);
    expect(retries).toBe(0);
    cb.failed(0); // schedules again
    cb.stop(); // cancels it
    vi.advanceTimersByTime(2000);
    expect(retries).toBe(0);
  });
});
