/**
 * Tests for the declarative `.autocloses({...})` close-policy overload
 * (#838 / epic #802).
 *
 * Top-level fields combine with AND. The `or: {...}` block opens an
 * alternative OR path — the policy fires when either the top-level
 * AND group matches or any field inside `or` matches. Per-field
 * semantics are isolated by single-field tests; the AND / OR
 * combinator tests exercise the multi-field paths and the mixed case
 * that motivated the AND-default choice (close 90 days after Resolved,
 * with a cardinality safety net).
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

describe(".autocloses({...}) — single-field semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("after: closes when head is strictly older than the window", () => {
    const p = policy({ after: { days: 90 } });
    const old_head = head_of("TicketOpened", new Date("2025-10-01T00:00:00Z"));
    expect(p("s", old_head, 1)).toBe(true);
  });

  it("after: does not close when head age is below the window", () => {
    const p = policy({ after: { days: 90 } });
    const fresh_head = head_of(
      "TicketOpened",
      new Date("2025-12-22T00:00:00Z")
    );
    expect(p("s", fresh_head, 1)).toBe(false);
  });

  it("after: inclusive `>=` at the window boundary", () => {
    const p = policy({ after: { days: 1 } });
    const boundary = head_of("X", new Date("2025-12-31T00:00:00Z"));
    expect(p("s", boundary, 1)).toBe(true);
  });

  it("after: supports fractional days for sub-day windows above the minute floor", () => {
    const p = policy({ after: { days: 1 / 24 } }); // 1 hour
    const head = head_of("X", new Date("2025-12-31T22:00:00Z")); // 2h ago
    expect(p("s", head, 1)).toBe(true);
  });

  it("is: matches a single string", () => {
    const p = policy({ is: "TicketResolved" });
    expect(p("s", head_of("TicketResolved", new Date()), 1)).toBe(true);
    expect(p("s", head_of("TicketOpened", new Date()), 1)).toBe(false);
  });

  it("is: matches any in an array", () => {
    const p = policy({ is: ["Shipped", "Delivered", "Cancelled"] });
    expect(p("s", head_of("Delivered", new Date()), 1)).toBe(true);
    expect(p("s", head_of("Shipped", new Date()), 1)).toBe(true);
    expect(p("s", head_of("Placed", new Date()), 1)).toBe(false);
  });

  it("reaches: inclusive `>=` at the threshold", () => {
    const p = policy({ reaches: 10_000 });
    expect(p("s", head_of("X", new Date()), 10_000)).toBe(true);
    expect(p("s", head_of("X", new Date()), 9_999)).toBe(false);
  });

  it("reaches: fires when count exceeds the threshold", () => {
    const p = policy({ reaches: 100 });
    expect(p("s", head_of("X", new Date()), 500)).toBe(true);
  });
});

describe(".autocloses({...}) — top-level AND combinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires when all top-level fields match (the cooldown-after-terminal case)", () => {
    const p = policy({ is: "Resolved", after: { days: 90 } });
    // Resolved AND 91 days old → close.
    expect(
      p("s", head_of("Resolved", new Date("2025-10-01T00:00:00Z")), 1)
    ).toBe(true);
  });

  it("does NOT fire when only `is` matches but `after` doesn't (still within cooldown)", () => {
    const p = policy({ is: "Resolved", after: { days: 90 } });
    // Resolved but only 7 days ago → still within cooldown.
    expect(
      p("s", head_of("Resolved", new Date("2025-12-25T00:00:00Z")), 1)
    ).toBe(false);
  });

  it("does NOT fire when only `after` matches but `is` doesn't (not terminal)", () => {
    const p = policy({ is: "Resolved", after: { days: 90 } });
    // Old enough but head is still Open.
    expect(p("s", head_of("Open", new Date("2025-10-01T00:00:00Z")), 1)).toBe(
      false
    );
  });

  it("ANDs all three fields together when all are set", () => {
    const p = policy({
      is: "Resolved",
      after: { days: 90 },
      reaches: 10,
    });
    // All three: Resolved, 91d, 10 events → close.
    expect(
      p("s", head_of("Resolved", new Date("2025-10-01T00:00:00Z")), 10)
    ).toBe(true);
    // Resolved, 91d, but only 5 events → no close (reaches fails).
    expect(
      p("s", head_of("Resolved", new Date("2025-10-01T00:00:00Z")), 5)
    ).toBe(false);
  });
});

describe(".autocloses({...}) — `or` block (alternative OR path)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires when any field inside `or` matches (pure OR pattern)", () => {
    const p = policy({ or: { is: "Resolved", reaches: 10_000 } });
    expect(p("s", head_of("Resolved", new Date()), 1)).toBe(true); // is matches
    expect(p("s", head_of("Open", new Date()), 10_000)).toBe(true); // reaches matches
    expect(p("s", head_of("Open", new Date()), 1)).toBe(false); // neither
  });

  it("mixed: top-level AND group matches (or-block irrelevant)", () => {
    const p = policy({
      is: "Resolved",
      after: { days: 90 },
      or: { reaches: 10_000 },
    });
    // Resolved + 91d → fires via AND group, regardless of count.
    expect(
      p("s", head_of("Resolved", new Date("2025-10-01T00:00:00Z")), 1)
    ).toBe(true);
  });

  it("mixed: or-block matches even when top-level AND group doesn't (safety-net path)", () => {
    const p = policy({
      is: "Resolved",
      after: { days: 90 },
      or: { reaches: 10_000 },
    });
    // Head Open, fresh — AND group fails — but count is 10k → fires via or-block.
    expect(p("s", head_of("Open", new Date()), 10_000)).toBe(true);
  });

  it("mixed: neither group matches → no close", () => {
    const p = policy({
      is: "Resolved",
      after: { days: 90 },
      or: { reaches: 10_000 },
    });
    expect(p("s", head_of("Open", new Date()), 1)).toBe(false);
  });

  it("matches via `or.after` (every field shape is supported inside the or-block)", () => {
    // Confirms the `or.after` compile path; the other `or.is` /
    // `or.reaches` paths are covered by the pure-OR test above.
    const p = policy({ or: { after: { days: 90 } } });
    expect(
      p("s", head_of("Anything", new Date("2025-10-01T00:00:00Z")), 1)
    ).toBe(true);
    expect(
      p("s", head_of("Anything", new Date("2025-12-25T00:00:00Z")), 1)
    ).toBe(false);
  });

  it("an `or`-only policy with no top-level fields does NOT match empty AND group", () => {
    // Regression guard for the in-cycle empty-AND check. Without
    // `and_preds.length > 0`, every() on an empty array would return
    // true and the policy would fire on every head — the universe
    // would close. The compiler synthesizes a `false` short-circuit
    // when there are no top-level fields so only the or-block can
    // fire.
    const p = policy({ or: { is: "Never" } });
    // No head ever named "Never" and no top-level AND → false.
    expect(p("s", head_of("Open", new Date()), 1)).toBe(false);
  });
});

describe(".autocloses({...}) — validation throws", () => {
  it("rejects an empty options bag", () => {
    expect(() => make_ticket().autocloses({} as never)).toThrow(/at least one/);
  });

  it("rejects an empty `or` block", () => {
    expect(() => make_ticket().autocloses({ or: {} as never })).toThrow(
      /at least one of after \/ is \/ reaches/
    );
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      make_ticket().autocloses({ unknown_field: 42 } as never)
    ).toThrow();
  });

  it("rejects unknown keys inside the `or` block (incl. nested `or`)", () => {
    expect(() =>
      make_ticket().autocloses({
        or: { or: { is: "Resolved" } } as never,
      })
    ).toThrow();
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

  it("propagates `or`-block field validation (same rules as top-level)", () => {
    expect(() => make_ticket().autocloses({ or: { reaches: 0 } })).toThrow(
      />= 1/
    );
    expect(() => make_ticket().autocloses({ or: { is: "" } })).toThrow(
      /non-empty/
    );
    expect(() =>
      make_ticket().autocloses({ or: { after: { days: -1 } } })
    ).toThrow(/> 0/);
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

  it("works on a stacked policy — top-level AND + or-block safety net", () => {
    const Ticket = make_ticket()
      .autocloses({
        is: "TicketResolved",
        after: { days: 90 },
        or: { reaches: 10_000 },
      })
      .build();
    expect(Ticket.autoclose).toBeTypeOf("function");
  });
});
