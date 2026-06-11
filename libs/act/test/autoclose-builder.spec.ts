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
  resolve_autoclose_config,
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
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
      make_ticket().autocloses("not a function" as any)
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
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
      make_ticket().archives("not a function" as any)
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

  it("returns null for unknown state names", () => {
    const Ticket = make_ticket().build();
    const app = act().withState(Ticket).build();
    expect(app.registry.autoclose_policy("Unknown")).toBeNull();
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

  it("returns null for unknown state names", () => {
    const Ticket = make_ticket().build();
    const app = act().withState(Ticket).build();
    expect(app.registry.autoclose_archiver("Unknown")).toBeNull();
  });
});

describe("resolve_autoclose_config — defaults + validation", () => {
  it("applies all defaults when no knobs are set", () => {
    const cfg = resolve_autoclose_config(undefined);
    expect(cfg.cycle_ms).toBe(DEFAULT_AUTOCLOSE_CYCLE_MS);
    expect(cfg.batch_size).toBe(DEFAULT_CLOSE_BATCH_SIZE);
    expect(cfg.yield_ms).toBe(DEFAULT_CLOSE_YIELD_MS);
    expect(cfg.close_on_error).toBe(false);
  });

  it("applies defaults when ActOptions has none of the autoclose keys", () => {
    const cfg = resolve_autoclose_config({});
    expect(cfg.cycle_ms).toBe(DEFAULT_AUTOCLOSE_CYCLE_MS);
    expect(cfg.batch_size).toBe(DEFAULT_CLOSE_BATCH_SIZE);
    expect(cfg.yield_ms).toBe(DEFAULT_CLOSE_YIELD_MS);
    expect(cfg.close_on_error).toBe(false);
  });

  it("preserves caller-supplied knobs", () => {
    const cfg = resolve_autoclose_config({
      autocloseCycleMs: 30_000,
      closeBatchSize: 128,
      closeYieldMs: 5,
      closeOnError: true,
    });
    expect(cfg.cycle_ms).toBe(30_000);
    expect(cfg.batch_size).toBe(128);
    expect(cfg.yield_ms).toBe(5);
    expect(cfg.close_on_error).toBe(true);
  });

  it("rejects autocloseCycleMs below the 10 s floor", () => {
    expect(() => resolve_autoclose_config({ autocloseCycleMs: 5_000 })).toThrow(
      RangeError
    );
  });

  it("rejects autocloseCycleMs above the 1 h ceiling", () => {
    expect(() =>
      resolve_autoclose_config({ autocloseCycleMs: 3_600_001 })
    ).toThrow(RangeError);
  });

  it("rejects non-finite autocloseCycleMs", () => {
    expect(() =>
      resolve_autoclose_config({ autocloseCycleMs: Number.NaN })
    ).toThrow(RangeError);
    expect(() =>
      resolve_autoclose_config({ autocloseCycleMs: Number.POSITIVE_INFINITY })
    ).toThrow(RangeError);
  });

  it("rejects closeBatchSize below 1", () => {
    expect(() => resolve_autoclose_config({ closeBatchSize: 0 })).toThrow(
      RangeError
    );
  });

  it("rejects closeBatchSize above 1024", () => {
    expect(() => resolve_autoclose_config({ closeBatchSize: 1025 })).toThrow(
      RangeError
    );
  });

  it("rejects non-integer closeBatchSize", () => {
    expect(() => resolve_autoclose_config({ closeBatchSize: 12.5 })).toThrow(
      RangeError
    );
  });

  it("rejects non-finite closeBatchSize", () => {
    expect(() =>
      resolve_autoclose_config({ closeBatchSize: Number.NaN })
    ).toThrow(RangeError);
  });

  it("rejects closeYieldMs below 0", () => {
    expect(() => resolve_autoclose_config({ closeYieldMs: -1 })).toThrow(
      RangeError
    );
  });

  it("rejects closeYieldMs above 1000", () => {
    expect(() => resolve_autoclose_config({ closeYieldMs: 1001 })).toThrow(
      RangeError
    );
  });

  it("rejects non-finite closeYieldMs", () => {
    expect(() =>
      resolve_autoclose_config({ closeYieldMs: Number.NaN })
    ).toThrow(RangeError);
  });
});

describe("act().build() — autoclose validation runs at build time", () => {
  it("out-of-range autocloseCycleMs throws on build", () => {
    expect(() =>
      act().withState(make_ticket().build()).build({ autocloseCycleMs: 1 })
    ).toThrow(RangeError);
  });

  it("out-of-range closeBatchSize throws on build", () => {
    expect(() =>
      act().withState(make_ticket().build()).build({ closeBatchSize: 99_999 })
    ).toThrow(RangeError);
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
