/**
 * Slice 1 of the online close-the-books foundation (#837 / epic #802).
 * Covers the declarator surface (`.autocloses(predicate)` on the state
 * builder), registry lookup (`registry.autoclose_policy(name)`), and
 * the `ActOptions` knob validation that runs at `act().build()`.
 *
 * No execution yet — slices 2-3 wire the cycle. This file proves the
 * shape so the policy-factory subs (#838 / #839 / #840) can be
 * authored against a stable surface.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  act,
  DEFAULT_AUTOCLOSE_CYCLE_MINUTES,
  DEFAULT_CLOSE_BATCH_SIZE,
  DEFAULT_CLOSE_YIELD_MS,
  resolveAutocloseConfig,
  state,
  ZodEmpty,
} from "../src/index.js";
import {
  hour_in_zone,
  in_autoclose_window,
} from "../src/internal/autoclose-config.js";

const make_ticket = () =>
  state({
    Ticket: z.object({ title: z.string(), open: z.boolean() }),
  })
    .init(() => ({ title: "", open: false }))
    .emits({
      TicketOpened: z.object({ title: z.string() }),
      TicketResolved: ZodEmpty,
    })
    .on({ OpenTicket: z.object({ title: z.string() }) })
    .emit((a) => ["TicketOpened", { title: a.title }])
    .on({ ResolveTicket: ZodEmpty })
    .emit(() => ["TicketResolved", {}]);

describe(".autocloses(policy) — declarator", () => {
  it("compiles the policy into a predicate on the built state", () => {
    const Ticket = make_ticket().autocloses({ is: "TicketResolved" }).build();
    expect(Ticket.autoclose).toBeInstanceOf(Function);
  });

  it("caches the policy's min `after` window (ms)", () => {
    const Ticket = make_ticket()
      .autocloses({ after: { days: 2 } })
      .build();
    expect(Ticket.autoclose_after_ms).toBe(2 * 86_400_000);
  });

  it("leaves autoclose_after_ms undefined for a policy with no `after`", () => {
    const Ticket = make_ticket().autocloses({ is: "TicketResolved" }).build();
    expect(Ticket.autoclose_after_ms).toBeUndefined();
  });

  it("takes the smallest `after` across top-level and the `or` block", () => {
    const Ticket = make_ticket()
      .autocloses({ after: { days: 90 }, or: { after: { days: 7 } } })
      .build();
    expect(Ticket.autoclose_after_ms).toBe(7 * 86_400_000);
  });

  it("is absent on states that didn't declare it", () => {
    const Ticket = make_ticket().build();
    expect(Ticket.autoclose).toBeUndefined();
    expect(Ticket.autoclose_after_ms).toBeUndefined();
  });

  it("replaces an earlier declaration (state-level, last-write-wins)", () => {
    // First sets an `after` window; the second (is-only) must clear it.
    const Ticket = make_ticket()
      .autocloses({ after: { days: 1 } })
      .autocloses({ is: "TicketResolved" })
      .build();
    expect(Ticket.autoclose_after_ms).toBeUndefined();
  });

  it("rejects the legacy function-predicate form with a migration message", () => {
    expect(() =>
      make_ticket().autocloses((() => true) as unknown as never)
    ).toThrow(/no longer supported/);
  });

  it("throws synchronously when the argument isn't a policy object", () => {
    expect(() =>
      make_ticket().autocloses("not a policy" as unknown as never)
    ).toThrow(/requires a policy object/);
    expect(() => make_ticket().autocloses(42 as unknown as never)).toThrow(
      /requires a policy object/
    );
    expect(() => make_ticket().autocloses(null as unknown as never)).toThrow(
      /requires a policy object/
    );
  });

  it("returns the same builder so chaining stays fluent", () => {
    const builder = make_ticket();
    const after = builder.autocloses({ is: "TicketResolved" });
    // Same identity — `.autocloses(...)` doesn't allocate a new builder.
    expect(after).toBe(builder);
  });
});

describe(".autocloses({ keep }) — rolling window (#1011)", () => {
  const snapping = () => make_ticket().snap((s) => s.patches >= 2);

  it("caches the window width on the built state", () => {
    const Ticket = snapping()
      .autocloses({ keep: { days: 180 } })
      .build();
    expect(Ticket.autoclose_keep_ms).toBe(180 * 86_400_000);
    // keep alone has no terminate component — no time gate either.
    expect(Ticket.autoclose_after_ms).toBeUndefined();
  });

  it("is absent on states whose policy has no keep", () => {
    const Ticket = snapping().autocloses({ is: "TicketResolved" }).build();
    expect(Ticket.autoclose_keep_ms).toBeUndefined();
  });

  it("accepts a keep-only policy whose terminate predicate never fires", () => {
    const Ticket = snapping()
      .autocloses({ keep: { days: 30 } })
      .build();
    const head = {
      id: 0,
      stream: "s",
      version: 0,
      created: new Date(0),
      name: "TicketResolved",
      data: {},
      meta: {} as never,
    } as never;
    expect(Ticket.autoclose!("s", head, 1_000_000)).toBe(false);
  });

  it("composes with terminate fields — both windows cached", () => {
    const Ticket = snapping()
      .autocloses({
        is: "TicketResolved",
        after: { days: 90 },
        keep: { days: 180 },
      })
      .build();
    expect(Ticket.autoclose_after_ms).toBe(90 * 86_400_000);
    expect(Ticket.autoclose_keep_ms).toBe(180 * 86_400_000);
  });

  it("requires .snap earlier in the chain — the runtime guard for untyped callers", () => {
    expect(() =>
      make_ticket().autocloses({ keep: { days: 180 } } as never)
    ).toThrow(/requires \.snap/);
  });

  it("gates keep behind .snap at the type level", () => {
    // @ts-expect-error — keep is only reachable after .snap(...)
    const gated = () => make_ticket().autocloses({ keep: { days: 180 } });
    expect(gated).toThrow(/requires \.snap/);
  });

  it("rejects windows below one day — close is low-cadence housekeeping", () => {
    expect(() => snapping().autocloses({ keep: { days: 0.5 } })).toThrow(
      /one day/
    );
    expect(() => snapping().autocloses({ keep: { days: -1 } })).toThrow(
      /keep\.days must be > 0/
    );
  });

  it("rejects keep inside the `or` block", () => {
    expect(() =>
      snapping().autocloses({
        or: { keep: { days: 30 } } as never,
      })
    ).toThrow();
  });

  it("counts toward the at-least-one-field rule", () => {
    // keep alone satisfies the rule; the empty bag still rejects.
    expect(() => snapping().autocloses({ keep: { days: 30 } })).not.toThrow();
    expect(() => snapping().autocloses({} as never)).toThrow(
      /at least one of after \/ is \/ reaches \/ or \/ keep/
    );
  });
});

describe(".archives(archive) — declarator", () => {
  it("registers the archiver on the built state", async () => {
    const archive = async () => {};
    const Ticket = make_ticket().archives(archive).build();
    expect(Ticket.archive).toBe(archive);
  });

  it("is absent on states that didn't declare it", () => {
    const Ticket = make_ticket().build();
    expect(Ticket.archive).toBeUndefined();
  });

  it("replaces an earlier declaration (last-write-wins)", () => {
    const first = async () => {};
    const second = async () => {};
    const Ticket = make_ticket().archives(first).archives(second).build();
    expect(Ticket.archive).toBe(second);
  });

  it("throws synchronously when the argument isn't a function", () => {
    expect(() =>
      make_ticket().archives("not a function" as unknown as never)
    ).toThrow(/requires a function/);
  });

  it("composes with .autocloses on the same builder", () => {
    const archive = async () => {};
    const Ticket = make_ticket()
      .autocloses({ is: "TicketResolved" })
      .archives(archive)
      .build();
    expect(Ticket.autoclose).toBeInstanceOf(Function);
    expect(Ticket.archive).toBe(archive);
  });

  it("is independent of .autocloses — declaring archiver alone is allowed", () => {
    // No `.autocloses(...)` → the cycle ignores the state entirely,
    // so the archiver never fires from the online path. It stays
    // available for explicit `app.close({ stream, archive })` calls
    // (sub: thread state.archive into the close path) without
    // requiring an autoclose predicate first.
    const archive = async () => {};
    const Ticket = make_ticket().archives(archive).build();
    expect(Ticket.autoclose).toBeUndefined();
    expect(Ticket.archive).toBe(archive);
  });
});

describe("registry.autoclose_policy(state_name) — lookup", () => {
  it("returns the compiled predicate the state declared", () => {
    const Ticket = make_ticket().autocloses({ is: "TicketResolved" }).build();
    const app = act().withState(Ticket).build();
    expect(app.registry.autoclose_policy("Ticket")).toBeInstanceOf(Function);
  });

  it("returns null for states without a predicate", () => {
    const Ticket = make_ticket().build();
    const app = act().withState(Ticket).build();
    expect(app.registry.autoclose_policy("Ticket")).toBeNull();
  });
});

describe("registry.autoclose_archiver(state_name) — lookup", () => {
  it("returns the archiver the state declared", () => {
    const archive = async () => {};
    const Ticket = make_ticket().archives(archive).build();
    const app = act().withState(Ticket).build();
    expect(app.registry.autoclose_archiver("Ticket")).toBe(archive);
  });

  it("returns null for states without an archiver", () => {
    const Ticket = make_ticket().build();
    const app = act().withState(Ticket).build();
    expect(app.registry.autoclose_archiver("Ticket")).toBeNull();
  });
});

describe("resolveAutocloseConfig — defaults + validation", () => {
  it("applies all defaults when no knobs are set", () => {
    const cfg = resolveAutocloseConfig(undefined);
    expect(cfg.autocloseCycleMinutes).toBe(DEFAULT_AUTOCLOSE_CYCLE_MINUTES);
    expect(cfg.closeBatchSize).toBe(DEFAULT_CLOSE_BATCH_SIZE);
    expect(cfg.closeYieldMs).toBe(DEFAULT_CLOSE_YIELD_MS);
    expect(cfg.closeOnError).toBe(false);
  });

  it("applies defaults when ActOptions has none of the autoclose keys", () => {
    const cfg = resolveAutocloseConfig({});
    expect(cfg.autocloseCycleMinutes).toBe(DEFAULT_AUTOCLOSE_CYCLE_MINUTES);
    expect(cfg.closeBatchSize).toBe(DEFAULT_CLOSE_BATCH_SIZE);
    expect(cfg.closeYieldMs).toBe(DEFAULT_CLOSE_YIELD_MS);
    expect(cfg.closeOnError).toBe(false);
  });

  it("preserves caller-supplied knobs", () => {
    const cfg = resolveAutocloseConfig({
      autocloseCycleMinutes: 600,
      closeBatchSize: 128,
      closeYieldMs: 5,
      closeOnError: true,
    });
    expect(cfg.autocloseCycleMinutes).toBe(600);
    expect(cfg.closeBatchSize).toBe(128);
    expect(cfg.closeYieldMs).toBe(5);
    expect(cfg.closeOnError).toBe(true);
  });

  it("rejects autocloseCycleMinutes below the 1 minute floor", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseCycleMinutes: 0 })
    ).toThrow();
  });

  it("rejects autocloseCycleMinutes above the 24 h ceiling", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseCycleMinutes: 1441 })
    ).toThrow();
  });

  it("rejects a non-integer autocloseCycleMinutes", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseCycleMinutes: 12.5 })
    ).toThrow();
  });

  it("rejects non-finite autocloseCycleMinutes", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseCycleMinutes: Number.NaN })
    ).toThrow();
    expect(() =>
      resolveAutocloseConfig({
        autocloseCycleMinutes: Number.POSITIVE_INFINITY,
      })
    ).toThrow();
  });

  it("rejects closeBatchSize below 1", () => {
    expect(() => resolveAutocloseConfig({ closeBatchSize: 0 })).toThrow();
  });

  it("rejects closeBatchSize above 1024", () => {
    expect(() => resolveAutocloseConfig({ closeBatchSize: 1025 })).toThrow();
  });

  it("rejects non-integer closeBatchSize", () => {
    expect(() => resolveAutocloseConfig({ closeBatchSize: 12.5 })).toThrow();
  });

  it("rejects non-finite closeBatchSize", () => {
    expect(() =>
      resolveAutocloseConfig({ closeBatchSize: Number.NaN })
    ).toThrow();
  });

  it("rejects closeYieldMs below 0", () => {
    expect(() => resolveAutocloseConfig({ closeYieldMs: -1 })).toThrow();
  });

  it("rejects closeYieldMs above 1000", () => {
    expect(() => resolveAutocloseConfig({ closeYieldMs: 1001 })).toThrow();
  });

  it("rejects non-finite closeYieldMs", () => {
    expect(() =>
      resolveAutocloseConfig({ closeYieldMs: Number.NaN })
    ).toThrow();
  });

  it("defaults autocloseWindow to undefined", () => {
    expect(resolveAutocloseConfig({}).autocloseWindow).toBeUndefined();
  });

  it("defaults autocloseWindow.timeZone to UTC", () => {
    const cfg = resolveAutocloseConfig({
      autocloseWindow: { start: 1, end: 5 },
    });
    expect(cfg.autocloseWindow).toEqual({ start: 1, end: 5, timeZone: "UTC" });
  });

  it("preserves a caller-supplied window timeZone", () => {
    const cfg = resolveAutocloseConfig({
      autocloseWindow: { start: 22, end: 6, timeZone: "America/New_York" },
    });
    expect(cfg.autocloseWindow?.timeZone).toBe("America/New_York");
  });

  it("rejects window hours outside [0, 23]", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseWindow: { start: -1, end: 5 } })
    ).toThrow();
    expect(() =>
      resolveAutocloseConfig({ autocloseWindow: { start: 1, end: 24 } })
    ).toThrow();
  });

  it("rejects a window where start equals end", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseWindow: { start: 3, end: 3 } })
    ).toThrow();
  });

  it("rejects an invalid window timeZone", () => {
    expect(() =>
      resolveAutocloseConfig({
        autocloseWindow: { start: 1, end: 5, timeZone: "Not/AZone" },
      })
    ).toThrow();
  });
});

describe("autoclose window membership", () => {
  it("hour_in_zone reads the wall-clock hour in the given zone", () => {
    // 2024-06-01T12:00:00Z is 08:00 in New York (EDT, UTC-4).
    const noonUtc = new Date("2024-06-01T12:00:00Z");
    expect(hour_in_zone(noonUtc, "UTC")).toBe(12);
    expect(hour_in_zone(noonUtc, "America/New_York")).toBe(8);
  });

  it("no window means always in window", () => {
    expect(
      in_autoclose_window(undefined, new Date("2024-06-01T12:00:00Z"))
    ).toBe(true);
  });

  it("same-day window includes [start, end) and excludes the rest", () => {
    const w = { start: 1, end: 5, timeZone: "UTC" };
    expect(in_autoclose_window(w, new Date("2024-06-01T01:00:00Z"))).toBe(true);
    expect(in_autoclose_window(w, new Date("2024-06-01T04:59:00Z"))).toBe(true);
    expect(in_autoclose_window(w, new Date("2024-06-01T05:00:00Z"))).toBe(
      false
    );
    expect(in_autoclose_window(w, new Date("2024-06-01T00:30:00Z"))).toBe(
      false
    );
  });

  it("overnight window (start > end) wraps past midnight", () => {
    const w = { start: 22, end: 6, timeZone: "UTC" };
    expect(in_autoclose_window(w, new Date("2024-06-01T23:00:00Z"))).toBe(true);
    expect(in_autoclose_window(w, new Date("2024-06-01T03:00:00Z"))).toBe(true);
    expect(in_autoclose_window(w, new Date("2024-06-01T12:00:00Z"))).toBe(
      false
    );
    expect(in_autoclose_window(w, new Date("2024-06-01T06:00:00Z"))).toBe(
      false
    );
  });
});

describe("act().build() — autoclose validation runs at build time", () => {
  it("out-of-range autocloseCycleMinutes throws on build", () => {
    expect(() =>
      act().withState(make_ticket().build()).build({ autocloseCycleMinutes: 0 })
    ).toThrow();
  });

  it("out-of-range closeBatchSize throws on build", () => {
    expect(() =>
      act().withState(make_ticket().build()).build({ closeBatchSize: 99_999 })
    ).toThrow();
  });

  it("valid knobs construct an Act successfully", () => {
    const Ticket = make_ticket().autocloses({ is: "TicketResolved" }).build();
    const app = act().withState(Ticket).build({
      autocloseCycleMinutes: 600,
      closeBatchSize: 32,
      closeYieldMs: 0,
    });
    expect(app.registry.autoclose_policy("Ticket")).toBeInstanceOf(Function);
  });
});
