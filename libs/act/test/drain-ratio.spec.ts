import type { HandleResult } from "../src/internal/drain-cycle.js";
import { compute_lag_lead_ratio } from "../src/internal/drain-ratio.js";
import type { Lease } from "../src/types/index.js";

const lease = (overrides: Partial<Lease> & { lagging: boolean }): Lease => ({
  stream: "s",
  at: 0,
  by: "test",
  retry: 0,
  ...overrides,
});

const result = (lagging: boolean, handled: number): HandleResult => ({
  lease: lease({ lagging }),
  handled,
  acked_at: handled,
});

describe("compute_lag_lead_ratio", () => {
  it("returns 0.5 when nothing was handled", () => {
    expect(compute_lag_lead_ratio([], 5, 5)).toBe(0.5);
    expect(
      compute_lag_lead_ratio([result(true, 0), result(false, 0)], 5, 5)
    ).toBe(0.5);
  });

  it("clamps to 0.8 when only lagging handled events", () => {
    const handled: HandleResult[] = [result(true, 100), result(true, 50)];
    expect(compute_lag_lead_ratio(handled, 5, 5)).toBe(0.8);
  });

  it("clamps to 0.2 when only leading handled events", () => {
    const handled: HandleResult[] = [result(false, 100), result(false, 50)];
    expect(compute_lag_lead_ratio(handled, 5, 5)).toBe(0.2);
  });

  it("balances proportionally between frontiers", () => {
    // 50 events in lagging at 5 streams = 10 avg
    // 50 events in leading at 5 streams = 10 avg
    // → ratio = 0.5
    const handled: HandleResult[] = [
      result(true, 25),
      result(true, 25),
      result(false, 25),
      result(false, 25),
    ];
    expect(compute_lag_lead_ratio(handled, 5, 5)).toBe(0.5);
  });

  it("favors the higher-pressure frontier", () => {
    // lagging avg = 30/5 = 6, leading avg = 10/5 = 2
    // ratio = 6 / 8 = 0.75 (within bounds)
    const handled: HandleResult[] = [result(true, 30), result(false, 10)];
    expect(compute_lag_lead_ratio(handled, 5, 5)).toBeCloseTo(0.75);
  });

  it("treats zero-size frontier as zero throughput", () => {
    // lagging frontier had 0 streams, so its avg is 0; leading drives the ratio
    const handled: HandleResult[] = [result(false, 50)];
    expect(compute_lag_lead_ratio(handled, 0, 5)).toBe(0.2);
  });
});
