import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { act, slice, state, ZodEmpty } from "../src/index.js";
import { check } from "../src/internal/config.js";
import { sandbox } from "../src/test/index.js";

/** Minimal state for the call-site assertions below. */
const S_cfg = state({ Cfg: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Bumped: ZodEmpty })
  .patch({ Bumped: (_e, st) => ({ n: st.n + 1 }) })
  .on({ bump: ZodEmpty })
  .emit(() => ["Bumped", {}])
  .build();

// The single config module (`internal/config.ts`) owns validation for every
// builder-facing bag. These pin `check` directly (unit) and at the
// declaration/runtime sites (throw), with the `maxRetries` NaN holes — the
// sibling of the backoff bug — as the headline regressions.

describe("check reaction", () => {
  it("accepts a valid bag", () => {
    expect(check("reaction", { blockOnError: true, maxRetries: 3 })).toEqual({
      blockOnError: true,
      maxRetries: 3,
    });
  });

  it("rejects a NaN maxRetries — the poison-quarantine gate (`retry >= NaN`) would never fire", () => {
    expect(() =>
      check("reaction", { blockOnError: true, maxRetries: Number.NaN })
    ).toThrow();
  });

  it("rejects a negative/fractional maxRetries and a non-boolean blockOnError", () => {
    expect(() =>
      check("reaction", { blockOnError: true, maxRetries: -1 })
    ).toThrow();
    expect(() =>
      check("reaction", { blockOnError: true, maxRetries: 2.5 })
    ).toThrow();
    expect(() =>
      check("reaction", { blockOnError: "yes" as never, maxRetries: 3 })
    ).toThrow();
  });

  it("rejects a bad nested backoff", () => {
    expect(() =>
      check("reaction", {
        blockOnError: true,
        maxRetries: 3,
        backoff: { strategy: "nope" as never, baseMs: 1 },
      })
    ).toThrow();
  });
});

describe("check action", () => {
  it("accepts a valid or empty bag", () => {
    expect(check("action", {})).toEqual({});
    expect(check("action", { maxRetries: 2 })).toEqual({ maxRetries: 2 });
  });

  it("rejects a NaN/Infinity maxRetries — the command retry loop (`attempt >= NaN`) would spin forever", () => {
    expect(() => check("action", { maxRetries: Number.NaN })).toThrow();
    expect(() =>
      check("action", { maxRetries: Number.POSITIVE_INFINITY })
    ).toThrow();
  });
});

describe("check lane", () => {
  it("accepts a valid lane", () => {
    const cfg = { name: "slow", leaseMillis: 30_000, streamLimit: 5 };
    expect(check("lane", cfg)).toEqual(cfg);
  });

  it("rejects an empty name, NaN leaseMillis, or negative streamLimit", () => {
    expect(() => check("lane", { name: "" })).toThrow();
    expect(() =>
      check("lane", { name: "x", leaseMillis: Number.NaN })
    ).toThrow();
    expect(() => check("lane", { name: "x", streamLimit: -1 })).toThrow();
  });

  /**
   * Both declaration paths must validate, not just `act()`. The slice path
   * used to register the bag raw, and a lane carrying a bad streamLimit
   * drained nothing for the life of the process — silently, with nothing in
   * `blocked_streams()` to find it by.
   */
  describe("both declaration paths validate", () => {
    const S = state({ Box: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Filled: ZodEmpty })
      .patch({ Filled: (_e, st) => ({ n: st.n + 1 }) })
      .on({ fill: ZodEmpty })
      .emit(() => ["Filled", {}])
      .build();

    const bad = [
      ["empty name", { name: "" }],
      ["NaN leaseMillis", { name: "l1", leaseMillis: Number.NaN }],
      ["negative streamLimit", { name: "l2", streamLimit: -1 }],
      ["NaN cycleMs", { name: "l3", cycleMs: Number.NaN }],
    ] as const;

    it.each(bad)("act().withLane rejects %s", (_label, config) => {
      expect(() =>
        act()
          .withState(S)
          .withLane(config as never)
      ).toThrow();
    });

    it.each(bad)("slice().withLane rejects %s", (_label, config) => {
      expect(() =>
        slice()
          .withState(S)
          .withLane(config as never)
      ).toThrow();
    });

    it("both paths still accept a valid lane", () => {
      expect(() =>
        act().withState(S).withLane({ name: "ok", streamLimit: 1 })
      ).not.toThrow();
      expect(() =>
        slice().withState(S).withLane({ name: "ok", streamLimit: 1 })
      ).not.toThrow();
    });
  });
});

describe("check drain / settle", () => {
  it("accept valid knobs (0 allowed)", () => {
    const d = { streamLimit: 10, eventLimit: 100, leaseMillis: 0 };
    expect(check("drain", d)).toEqual(d);
    const s = { debounceMs: 0, maxPasses: 3, leaseMillis: 5 };
    expect(check("settle", s)).toEqual(s);
  });

  it("reject NaN/negative knobs", () => {
    expect(() => check("drain", { leaseMillis: Number.NaN })).toThrow();
    expect(() => check("drain", { streamLimit: -1 })).toThrow();
    expect(() => check("settle", { debounceMs: Number.NaN })).toThrow();
    expect(() => check("settle", { maxPasses: -1 })).toThrow();
  });

  /**
   * `Infinity` is what both public doc-comments name as `maxPasses`'s default,
   * and what `settle.ts` destructures to — so the one value the docs advertise
   * was the one value the schema refused. Reached by wrapper code
   * normalizing an optional cap: `settle({ maxPasses: opts.maxPasses ?? Infinity })`.
   */
  it("accepts maxPasses: Infinity, the documented default", () => {
    const s = { maxPasses: Number.POSITIVE_INFINITY };
    expect(check("settle", s)).toEqual(s);
  });

  it("still rejects -Infinity and NaN for maxPasses", () => {
    // Accepting the documented "no cap" value must not open the gate to
    // nonsense — the union admits one literal, not every non-finite number.
    expect(() =>
      check("settle", { maxPasses: Number.NEGATIVE_INFINITY })
    ).toThrow();
    expect(() => check("settle", { maxPasses: Number.NaN })).toThrow();
    expect(() => check("settle", { maxPasses: 1.5 })).toThrow();
  });

  it("settle({ maxPasses: Infinity }) does not throw at the call site", async () => {
    const ctx = await sandbox(act().withState(S_cfg), {
      actOptions: { autoSettle: false },
    });
    try {
      // The integer check alone refused the documented default.
      await ctx.app.settle({ maxPasses: Number.POSITIVE_INFINITY });
    } finally {
      await ctx.dispose();
    }
  });
});

describe("check act", () => {
  it("returns a valid bag", () => {
    const o = { maxSubscribedStreams: 100, settleDebounceMs: 10 };
    expect(check("act", o)).toEqual(o);
  });

  it("rejects NaN/out-of-range scalar knobs", () => {
    expect(() => check("act", { maxSubscribedStreams: 0 })).toThrow();
    expect(() => check("act", { settleDebounceMs: Number.NaN })).toThrow();
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

  it("refuses a poll frequency or a page limit Node or the store can't honor", async () => {
    const ctx = await sandbox(act().withState(counter), {
      actOptions: { autoSettle: false },
    });
    try {
      const { app } = ctx;
      // A NaN, negative or too-large frequency runs a Node timer every 1 ms.
      for (const frequency of [Number.NaN, -5, Number.POSITIVE_INFINITY])
        expect(() => app.start_correlations({}, frequency)).toThrow(ZodError);
      expect(() => app.start_correlations({ limit: Number.NaN })).toThrow(
        ZodError
      );
      await expect(app.correlate({ limit: Number.NaN })).rejects.toThrow(
        ZodError
      );
      await expect(app.blocked_streams({ limit: -1 })).rejects.toThrow(
        ZodError
      );
      expect(() => app.settle({ correlate: { limit: 1.5 } })).toThrow(ZodError);
      await expect(app.query({ limit: Number.NaN })).rejects.toThrow(ZodError);
      await expect(app.query_array({ limit: -1 })).rejects.toThrow(ZodError);
      // Control: 0 keeps its meaning (the poll's default, no limit elsewhere).
      expect(app.start_correlations({ limit: 0 }, 0)).toBe(true);
      app.stop_correlations();
      await expect(app.correlate({ limit: 0 })).resolves.toBeDefined();
      await expect(app.blocked_streams({ limit: 0 })).resolves.toEqual([]);
      await expect(app.query_array({ limit: 0 })).resolves.toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });

  it("reaction with a NaN maxRetries throws at build", () => {
    async function react() {}
    expect(() =>
      act()
        .withState(counter)
        .on("ticked")
        .do(react, { maxRetries: Number.NaN })
        .build()
    ).toThrow();
  });

  it("a static target's priority must be a 32-bit integer, checked at declaration", () => {
    async function react() {}
    const route = (priority: number) =>
      act()
        .withState(counter)
        .on("ticked")
        .do(react)
        .to({ target: "out", priority });
    expect(() => route(1.5)).toThrow();
    expect(() => route(3_000_000_000)).toThrow();
    expect(() => route(Number.NaN)).toThrow();
    expect(() => route(-10).build()).not.toThrow();
    expect(() =>
      act().withState(counter).on("ticked").do(react).to("out").build()
    ).not.toThrow();
  });

  it("action with a NaN maxRetries throws at build", () => {
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

  it("act().build({ autoSettle: false }) with a bad maxSubscribedStreams throws", () => {
    expect(() =>
      act().withState(counter).build({ maxSubscribedStreams: 0 })
    ).toThrow();
  });

  it("drain() / settle() with a NaN knob throw at the call", async () => {
    const app = act().withState(counter).build({ autoSettle: false });
    await expect(app.drain({ leaseMillis: Number.NaN })).rejects.toThrow();
    expect(() => app.settle({ debounceMs: Number.NaN })).toThrow();
  });
});
