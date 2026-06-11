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
  DEFAULT_AUTOCLOSE_CYCLE_MS,
  DEFAULT_CLOSE_BATCH_SIZE,
  DEFAULT_CLOSE_YIELD_MS,
  resolveAutocloseConfig,
  state,
  ZodEmpty,
} from "../src/index.js";

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

describe(".autocloses(predicate) — declarator", () => {
  it("registers the predicate on the built state", () => {
    const pred = () => true;
    const Ticket = make_ticket().autocloses(pred).build();
    expect(Ticket.autoclose).toBe(pred);
  });

  it("is absent on states that didn't declare it", () => {
    const Ticket = make_ticket().build();
    expect(Ticket.autoclose).toBeUndefined();
  });

  it("replaces an earlier declaration (state-level, last-write-wins)", () => {
    const first = () => false;
    const second = () => true;
    const Ticket = make_ticket().autocloses(first).autocloses(second).build();
    expect(Ticket.autoclose).toBe(second);
  });

  it("throws synchronously when the argument isn't a function", () => {
    expect(() =>
      make_ticket().autocloses("not a function" as unknown as never)
    ).toThrow(/requires a function/);
  });

  it("returns the same builder so chaining stays fluent", () => {
    const builder = make_ticket();
    const after = builder.autocloses(() => false);
    // Same identity — `.autocloses(...)` doesn't allocate a new builder.
    expect(after).toBe(builder);
  });

  it("the predicate's `head.event.name` is typed against the state's event union", () => {
    // Type-only assertion — compiles iff the union is threaded. Runtime
    // value is irrelevant; the check is the inference at the call site.
    make_ticket().autocloses((_stream, head) => {
      // @ts-expect-error — "Nope" is not in the state's event union
      const _bad = head.name === "Nope";
      const ok = head.name === "TicketOpened" || head.name === "TicketResolved";
      return ok;
    });
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
    const predicate = () => true;
    const archive = async () => {};
    const Ticket = make_ticket()
      .autocloses(predicate)
      .archives(archive)
      .build();
    expect(Ticket.autoclose).toBe(predicate);
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
  it("returns the predicate the state declared", () => {
    const pred = () => true;
    const Ticket = make_ticket().autocloses(pred).build();
    const app = act().withState(Ticket).build();
    expect(app.registry.autoclose_policy("Ticket")).toBe(pred);
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
    expect(cfg.autocloseCycleMs).toBe(DEFAULT_AUTOCLOSE_CYCLE_MS);
    expect(cfg.closeBatchSize).toBe(DEFAULT_CLOSE_BATCH_SIZE);
    expect(cfg.closeYieldMs).toBe(DEFAULT_CLOSE_YIELD_MS);
    expect(cfg.closeOnError).toBe(false);
  });

  it("applies defaults when ActOptions has none of the autoclose keys", () => {
    const cfg = resolveAutocloseConfig({});
    expect(cfg.autocloseCycleMs).toBe(DEFAULT_AUTOCLOSE_CYCLE_MS);
    expect(cfg.closeBatchSize).toBe(DEFAULT_CLOSE_BATCH_SIZE);
    expect(cfg.closeYieldMs).toBe(DEFAULT_CLOSE_YIELD_MS);
    expect(cfg.closeOnError).toBe(false);
  });

  it("preserves caller-supplied knobs", () => {
    const cfg = resolveAutocloseConfig({
      autocloseCycleMs: 30_000,
      closeBatchSize: 128,
      closeYieldMs: 5,
      closeOnError: true,
    });
    expect(cfg.autocloseCycleMs).toBe(30_000);
    expect(cfg.closeBatchSize).toBe(128);
    expect(cfg.closeYieldMs).toBe(5);
    expect(cfg.closeOnError).toBe(true);
  });

  it("rejects autocloseCycleMs below the 10 s floor", () => {
    expect(() => resolveAutocloseConfig({ autocloseCycleMs: 5_000 })).toThrow();
  });

  it("rejects autocloseCycleMs above the 1 h ceiling", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseCycleMs: 3_600_001 })
    ).toThrow();
  });

  it("rejects non-finite autocloseCycleMs", () => {
    expect(() =>
      resolveAutocloseConfig({ autocloseCycleMs: Number.NaN })
    ).toThrow();
    expect(() =>
      resolveAutocloseConfig({ autocloseCycleMs: Number.POSITIVE_INFINITY })
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
});

describe("act().build() — autoclose validation runs at build time", () => {
  it("out-of-range autocloseCycleMs throws on build", () => {
    expect(() =>
      act().withState(make_ticket().build()).build({ autocloseCycleMs: 1 })
    ).toThrow();
  });

  it("out-of-range closeBatchSize throws on build", () => {
    expect(() =>
      act().withState(make_ticket().build()).build({ closeBatchSize: 99_999 })
    ).toThrow();
  });

  it("valid knobs construct an Act successfully", () => {
    const Ticket = make_ticket()
      .autocloses((_stream, head) => head.name === "TicketResolved")
      .build();
    const app = act().withState(Ticket).build({
      autocloseCycleMs: 30_000,
      closeBatchSize: 32,
      closeYieldMs: 0,
    });
    expect(app.registry.autoclose_policy("Ticket")).toBeInstanceOf(Function);
  });
});
