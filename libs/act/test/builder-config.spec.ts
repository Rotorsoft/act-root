import { describe, expect, it } from "vitest";
import { z } from "zod";
import { act, state, ZodEmpty } from "../src/index.js";
import {
  resolveActConfig,
  resolveActionConfig,
  resolveDrainConfig,
  resolveLaneConfig,
  resolveReactionConfig,
  resolveSettleConfig,
} from "../src/internal/config.js";

// The single config module (`internal/config.ts`) owns validation for every
// builder-facing bag. These pin the resolvers directly (unit) and at their
// declaration/runtime sites (throw), with the `maxRetries` NaN holes — the
// sibling of the backoff bug — as the headline regressions (#1269).

describe("resolveReactionConfig", () => {
  it("accepts a valid bag", () => {
    expect(
      resolveReactionConfig({ blockOnError: true, maxRetries: 3 })
    ).toEqual({ blockOnError: true, maxRetries: 3 });
  });

  it("rejects a NaN maxRetries — the poison-quarantine gate (`retry >= NaN`) would never fire", () => {
    expect(() =>
      resolveReactionConfig({ blockOnError: true, maxRetries: Number.NaN })
    ).toThrow();
  });

  it("rejects a negative/fractional maxRetries and a non-boolean blockOnError", () => {
    expect(() =>
      resolveReactionConfig({ blockOnError: true, maxRetries: -1 })
    ).toThrow();
    expect(() =>
      resolveReactionConfig({ blockOnError: true, maxRetries: 2.5 })
    ).toThrow();
    expect(() =>
      resolveReactionConfig({ blockOnError: "yes" as never, maxRetries: 3 })
    ).toThrow();
  });

  it("rejects a bad nested backoff", () => {
    expect(() =>
      resolveReactionConfig({
        blockOnError: true,
        maxRetries: 3,
        backoff: { strategy: "nope" as never, baseMs: 1 },
      })
    ).toThrow();
  });
});

describe("resolveActionConfig", () => {
  it("accepts a valid or empty bag", () => {
    expect(resolveActionConfig({})).toEqual({});
    expect(resolveActionConfig({ maxRetries: 2 })).toEqual({ maxRetries: 2 });
  });

  it("rejects a NaN/Infinity maxRetries — the command retry loop (`attempt >= NaN`) would spin forever", () => {
    expect(() => resolveActionConfig({ maxRetries: Number.NaN })).toThrow();
    expect(() =>
      resolveActionConfig({ maxRetries: Number.POSITIVE_INFINITY })
    ).toThrow();
  });
});

describe("resolveLaneConfig", () => {
  it("accepts a valid lane and returns it", () => {
    const cfg = { name: "slow", leaseMillis: 30_000, streamLimit: 5 };
    expect(resolveLaneConfig(cfg)).toBe(cfg);
  });

  it("rejects an empty name, NaN leaseMillis, or negative streamLimit", () => {
    expect(() => resolveLaneConfig({ name: "" })).toThrow();
    expect(() =>
      resolveLaneConfig({ name: "x", leaseMillis: Number.NaN })
    ).toThrow();
    expect(() => resolveLaneConfig({ name: "x", streamLimit: -1 })).toThrow();
  });
});

describe("resolveDrainConfig / resolveSettleConfig", () => {
  it("pass undefined through", () => {
    expect(resolveDrainConfig(undefined)).toBeUndefined();
    expect(resolveSettleConfig(undefined)).toBeUndefined();
  });

  it("accept valid knobs (0 allowed) and return the input", () => {
    const d = { streamLimit: 10, eventLimit: 100, leaseMillis: 0 };
    expect(resolveDrainConfig(d)).toBe(d);
    const s = { debounceMs: 0, maxPasses: 3, leaseMillis: 5 };
    expect(resolveSettleConfig(s)).toBe(s);
  });

  it("reject NaN/negative knobs", () => {
    expect(() => resolveDrainConfig({ leaseMillis: Number.NaN })).toThrow();
    expect(() => resolveDrainConfig({ streamLimit: -1 })).toThrow();
    expect(() => resolveSettleConfig({ debounceMs: Number.NaN })).toThrow();
    expect(() => resolveSettleConfig({ maxPasses: -1 })).toThrow();
  });
});

describe("resolveActConfig", () => {
  it("passes undefined through and returns a valid bag", () => {
    expect(resolveActConfig(undefined)).toBeUndefined();
    const o = { maxSubscribedStreams: 100, settleDebounceMs: 10 };
    expect(resolveActConfig(o)).toBe(o);
  });

  it("rejects NaN/out-of-range scalar knobs", () => {
    expect(() => resolveActConfig({ maxSubscribedStreams: 0 })).toThrow();
    expect(() => resolveActConfig({ settleDebounceMs: Number.NaN })).toThrow();
  });
});

describe("config is validated at the declaration/runtime site", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  it("reaction with a NaN maxRetries throws at build (#1269 sibling)", () => {
    async function react() {}
    expect(() =>
      act()
        .withState(counter)
        .on("ticked")
        .do(react, { maxRetries: Number.NaN })
        .build()
    ).toThrow();
  });

  it("action with a NaN maxRetries throws at build (#1269 sibling)", () => {
    expect(() =>
      state({ S: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ e: ZodEmpty })
        .patch({ e: () => ({}) })
        .on({ act: ZodEmpty }, { maxRetries: Number.NaN })
        .emit(() => ["e", {}])
        .build()
    ).toThrow();
  });

  it("withLane with a NaN leaseMillis throws at build", () => {
    expect(() =>
      act()
        .withState(counter)
        .withLane({ name: "slow", leaseMillis: Number.NaN })
        .build()
    ).toThrow();
  });

  it("act().build() with a bad maxSubscribedStreams throws", () => {
    expect(() =>
      act().withState(counter).build({ maxSubscribedStreams: 0 })
    ).toThrow();
  });

  it("drain() / settle() with a NaN knob throw at the call", async () => {
    const app = act().withState(counter).build();
    await expect(app.drain({ leaseMillis: Number.NaN })).rejects.toThrow();
    expect(() => app.settle({ debounceMs: Number.NaN })).toThrow();
  });
});
