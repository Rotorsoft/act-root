/**
 * Tests for the `when({...})` close-policy factory (#838 / epic #802).
 *
 * Covers per-field semantics (`olderThan`, `on`, `count`), the OR
 * composition across fields, and the Zod-validation reject paths. The
 * predicate-return type is verified by assignment into a real
 * `.autocloses(when(...))` call site at the bottom of the file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, state, when, ZodEmpty } from "../src/index.js";

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

// Minimal `head` shape the predicate inspects. The factory reads
// `head.name` (event name) and `head.created` (Date) only — anything
// else is type noise the structural type elides.
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

describe("when() — olderThan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes when head is strictly older than the window", () => {
    const predicate = when({ olderThan: { days: 90 } });
    // 91 days old → close.
    const old_head = head_of("TicketOpened", new Date("2025-10-01T00:00:00Z"));
    expect(predicate("s", old_head, 1)).toBe(true);
  });

  it("does not close when head age is below the window", () => {
    const predicate = when({ olderThan: { days: 90 } });
    // 10 days old → not yet.
    const fresh_head = head_of(
      "TicketOpened",
      new Date("2025-12-22T00:00:00Z")
    );
    expect(predicate("s", fresh_head, 1)).toBe(false);
  });

  it("closes at exactly the window boundary (inclusive `>=`)", () => {
    const predicate = when({ olderThan: { days: 1 } });
    // Head created exactly 24h ago.
    const boundary = head_of("X", new Date("2025-12-31T00:00:00Z"));
    expect(predicate("s", boundary, 1)).toBe(true);
  });

  it("supports fractional days for sub-day windows above the minute floor", () => {
    const predicate = when({ olderThan: { days: 1 / 24 } }); // 1 hour
    const head = head_of("X", new Date("2025-12-31T22:00:00Z")); // 2h ago
    expect(predicate("s", head, 1)).toBe(true);
  });
});

describe("when() — on", () => {
  it("closes when head event name matches a single string", () => {
    const predicate = when({ on: "TicketResolved" });
    expect(predicate("s", head_of("TicketResolved", new Date()), 1)).toBe(true);
    expect(predicate("s", head_of("TicketOpened", new Date()), 1)).toBe(false);
  });

  it("closes when head event name matches any in an array", () => {
    const predicate = when({ on: ["Shipped", "Delivered", "Cancelled"] });
    expect(predicate("s", head_of("Delivered", new Date()), 1)).toBe(true);
    expect(predicate("s", head_of("Shipped", new Date()), 1)).toBe(true);
    expect(predicate("s", head_of("Placed", new Date()), 1)).toBe(false);
  });
});

describe("when() — count", () => {
  it("closes at exactly the threshold (inclusive `>=`)", () => {
    const predicate = when({ count: 10_000 });
    expect(predicate("s", head_of("X", new Date()), 10_000)).toBe(true);
    expect(predicate("s", head_of("X", new Date()), 9_999)).toBe(false);
  });

  it("closes when count exceeds the threshold", () => {
    const predicate = when({ count: 100 });
    expect(predicate("s", head_of("X", new Date()), 500)).toBe(true);
  });
});

describe("when() — OR composition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when any single field matches", () => {
    const predicate = when({
      olderThan: { days: 365 },
      on: "Resolved",
      count: 10_000,
    });
    // Only `on` matches.
    expect(
      predicate("s", head_of("Resolved", new Date("2025-12-25T00:00:00Z")), 1)
    ).toBe(true);
    // Only `count` matches.
    expect(
      predicate("s", head_of("Open", new Date("2025-12-25T00:00:00Z")), 10_000)
    ).toBe(true);
    // Only `olderThan` matches.
    expect(
      predicate("s", head_of("Open", new Date("2024-06-01T00:00:00Z")), 1)
    ).toBe(true);
  });

  it("returns false when nothing matches", () => {
    const predicate = when({
      olderThan: { days: 365 },
      on: "Resolved",
      count: 10_000,
    });
    expect(
      predicate("s", head_of("Open", new Date("2025-12-25T00:00:00Z")), 1)
    ).toBe(false);
  });
});

describe("when() — validation throws", () => {
  it("rejects an empty options bag", () => {
    expect(() => when({} as never)).toThrow(/at least one/);
  });

  it("rejects sub-minute `olderThan` resolved durations", () => {
    // 30 seconds → 30_000ms — below the one-minute floor.
    expect(() => when({ olderThan: { days: 30 / 86_400 } })).toThrow(
      /too short to be a meaningful retention window/
    );
  });

  it("rejects `olderThan.days` of zero or negative", () => {
    expect(() => when({ olderThan: { days: 0 } })).toThrow(/> 0/);
    expect(() => when({ olderThan: { days: -1 } })).toThrow(/> 0/);
  });

  it("rejects `count` below 1", () => {
    expect(() => when({ count: 0 })).toThrow(/>= 1/);
    expect(() => when({ count: -5 })).toThrow(/>= 1/);
  });

  it("rejects non-integer `count`", () => {
    expect(() => when({ count: 1.5 })).toThrow(/integer/);
  });

  it("rejects empty-string `on`", () => {
    expect(() => when({ on: "" })).toThrow(/non-empty/);
  });

  it("rejects empty-array `on`", () => {
    expect(() => when({ on: [] })).toThrow(/at least one/);
  });

  it("rejects empty-string entries in `on` array", () => {
    expect(() => when({ on: ["Resolved", ""] })).toThrow(/non-empty/);
  });
});

describe("when() — call-site assignment to .autocloses()", () => {
  it("is assignable to `.autocloses(...)` on a typed state builder", () => {
    // Compiles only if the returned predicate is structurally
    // compatible with `AutoclosePredicate<TicketEvents>`. The runtime
    // assertion below is incidental — the build is the real test.
    const Ticket = make_ticket()
      .autocloses(
        when({
          olderThan: { days: 90 },
          on: "TicketResolved",
          count: 10_000,
        })
      )
      .build();
    expect(Ticket.autoclose).toBeTypeOf("function");
  });

  it("threads through `act().build()` and registers as the state's policy", () => {
    const Ticket = make_ticket()
      .autocloses(when({ count: 10 }))
      .build();
    const app = act().withState(Ticket).build();
    const policy = app.registry.autoclose_policy("Ticket");
    expect(policy).toBeTypeOf("function");
  });
});
