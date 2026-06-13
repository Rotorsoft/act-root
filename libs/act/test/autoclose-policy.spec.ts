/**
 * Tests for the declarative `.autocloses({...})` close-policy overload
 * (#838 / epic #802). Covers per-field semantics (`after`, `is`,
 * `reaches`), the OR composition across fields, and the Zod-validation
 * reject paths.
 *
 * The declarative form lives on the builder method itself — no `when()`
 * factory wrapper. `.autocloses(predicate_fn)` keeps working unchanged
 * for custom policies (verified in `autoclose-builder.spec.ts`); this
 * spec exercises the object-literal form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, state, ZodEmpty } from "../src/index.js";

const make_ticket = () =>
  state({ Ticket: z.object({ open: z.boolean() }) })
    .init(() => ({ open: false }))
    .emits({
      TicketOpened: z.object({ title: z.string() }),
      TicketResolved: ZodEmpty,
    })
    .on({ OpenTicket: z.object({ title: z.string() }) })
    .emit((a) => ["TicketOpened", { title: a.title }])
    .on({ ResolveTicket: ZodEmpty })
    .emit(() => ["TicketResolved", {}]);

// Minimal `head` shape the compiled predicate inspects. The factory
// reads `head.name` (event name) and `head.created` (Date) only —
// anything else is type noise the structural type elides.
const head_of = (name: string, created: Date) =>
  ({
    name,
    created,
    id: 0,
    stream: "stream",
    version: 0,
    data: {},
    meta: {} as never,
  }) as never;

// Build a state with the given policy and return the compiled
// predicate via `state.autoclose`. The builder is the only entry point
// — `compile_autoclose_policy` is internal.
const policy = (
  opts: Parameters<ReturnType<typeof make_ticket>["autocloses"]>[0]
) =>
  make_ticket().autocloses(opts).build().autoclose as NonNullable<
    ReturnType<ReturnType<typeof make_ticket>["build"]>["autoclose"]
  >;

describe(".autocloses({...}) — after", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes when head is strictly older than the window", () => {
    const p = policy({ after: { days: 90 } });
    // 91 days old → close.
    const old_head = head_of("TicketOpened", new Date("2025-10-01T00:00:00Z"));
    expect(p("s", old_head, 1)).toBe(true);
  });

  it("does not close when head age is below the window", () => {
    const p = policy({ after: { days: 90 } });
    const fresh_head = head_of(
      "TicketOpened",
      new Date("2025-12-22T00:00:00Z")
    );
    expect(p("s", fresh_head, 1)).toBe(false);
  });

  it("closes at exactly the window boundary (inclusive `>=`)", () => {
    const p = policy({ after: { days: 1 } });
    const boundary = head_of("X", new Date("2025-12-31T00:00:00Z"));
    expect(p("s", boundary, 1)).toBe(true);
  });

  it("supports fractional days for sub-day windows above the minute floor", () => {
    const p = policy({ after: { days: 1 / 24 } }); // 1 hour
    const head = head_of("X", new Date("2025-12-31T22:00:00Z")); // 2h ago
    expect(p("s", head, 1)).toBe(true);
  });
});

describe(".autocloses({...}) — is", () => {
  it("closes when head event name matches a single string", () => {
    const p = policy({ is: "TicketResolved" });
    expect(p("s", head_of("TicketResolved", new Date()), 1)).toBe(true);
    expect(p("s", head_of("TicketOpened", new Date()), 1)).toBe(false);
  });

  it("closes when head event name matches any in an array", () => {
    const p = policy({ is: ["Shipped", "Delivered", "Cancelled"] });
    expect(p("s", head_of("Delivered", new Date()), 1)).toBe(true);
    expect(p("s", head_of("Shipped", new Date()), 1)).toBe(true);
    expect(p("s", head_of("Placed", new Date()), 1)).toBe(false);
  });
});

describe(".autocloses({...}) — reaches", () => {
  it("closes at exactly the threshold (inclusive `>=`)", () => {
    const p = policy({ reaches: 10_000 });
    expect(p("s", head_of("X", new Date()), 10_000)).toBe(true);
    expect(p("s", head_of("X", new Date()), 9_999)).toBe(false);
  });

  it("closes when count exceeds the threshold", () => {
    const p = policy({ reaches: 100 });
    expect(p("s", head_of("X", new Date()), 500)).toBe(true);
  });
});

describe(".autocloses({...}) — OR composition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when any single field matches", () => {
    const p = policy({
      after: { days: 365 },
      is: "Resolved",
      reaches: 10_000,
    });
    // Only `is` matches.
    expect(
      p("s", head_of("Resolved", new Date("2025-12-25T00:00:00Z")), 1)
    ).toBe(true);
    // Only `reaches` matches.
    expect(
      p("s", head_of("Open", new Date("2025-12-25T00:00:00Z")), 10_000)
    ).toBe(true);
    // Only `after` matches.
    expect(p("s", head_of("Open", new Date("2024-06-01T00:00:00Z")), 1)).toBe(
      true
    );
  });

  it("returns false when nothing matches", () => {
    const p = policy({
      after: { days: 365 },
      is: "Resolved",
      reaches: 10_000,
    });
    expect(p("s", head_of("Open", new Date("2025-12-25T00:00:00Z")), 1)).toBe(
      false
    );
  });
});

describe(".autocloses({...}) — validation throws", () => {
  it("rejects an empty options bag", () => {
    expect(() => make_ticket().autocloses({} as never)).toThrow(/at least one/);
  });

  it("rejects sub-minute `after` resolved durations", () => {
    expect(() =>
      make_ticket().autocloses({ after: { days: 30 / 86_400 } })
    ).toThrow(/too short to be a meaningful retention window/);
  });

  it("rejects `after.days` of zero or negative", () => {
    expect(() => make_ticket().autocloses({ after: { days: 0 } })).toThrow(
      /> 0/
    );
    expect(() => make_ticket().autocloses({ after: { days: -1 } })).toThrow(
      /> 0/
    );
  });

  it("rejects `reaches` below 1", () => {
    expect(() => make_ticket().autocloses({ reaches: 0 })).toThrow(/>= 1/);
    expect(() => make_ticket().autocloses({ reaches: -5 })).toThrow(/>= 1/);
  });

  it("rejects non-integer `reaches`", () => {
    expect(() => make_ticket().autocloses({ reaches: 1.5 })).toThrow(/integer/);
  });

  it("rejects empty-string `is`", () => {
    expect(() => make_ticket().autocloses({ is: "" })).toThrow(/non-empty/);
  });

  it("rejects empty-array `is`", () => {
    expect(() => make_ticket().autocloses({ is: [] })).toThrow(/at least one/);
  });

  it("rejects empty-string entries in `is` array", () => {
    expect(() => make_ticket().autocloses({ is: ["Resolved", ""] })).toThrow(
      /non-empty/
    );
  });
});

describe(".autocloses({...}) — declarator + registry", () => {
  it("registers the compiled predicate on the built state", () => {
    const Ticket = make_ticket().autocloses({ is: "TicketResolved" }).build();
    expect(Ticket.autoclose).toBeTypeOf("function");
  });

  it("threads through `act().build()` and registers as the state's policy", () => {
    const Ticket = make_ticket().autocloses({ reaches: 10 }).build();
    const app = act().withState(Ticket).build();
    const result = app.registry.autoclose_policy("Ticket");
    expect(result).toBeTypeOf("function");
  });

  it("works on a stacked policy (OR across all three pressures)", () => {
    const Ticket = make_ticket()
      .autocloses({
        after: { days: 90 },
        is: "TicketResolved",
        reaches: 10_000,
      })
      .build();
    expect(Ticket.autoclose).toBeTypeOf("function");
  });
});
