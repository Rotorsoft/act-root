import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, dispose, log, sensitive, state } from "../src/index.js";

/**
 * The build-time checks of states whose events carry `sensitive(...)`
 * fields: such a state can't snapshot, and a sensitive field whose type
 * isn't a string is named in a warning.
 */

// A state named `name` with one event per entry, each patched to the same
// state, and one action (`<name>_join`) that emits the first of them.
const member = (
  name: string,
  events: Record<string, Record<string, z.ZodType>>,
  {
    shape = {},
    snap = false,
  }: { shape?: Record<string, z.ZodType>; snap?: boolean } = {}
) => {
  const names = Object.keys(events);
  const builder = state({ [name]: z.object(shape) })
    .init(() => ({}))
    .emits(
      Object.fromEntries(names.map((e) => [e, z.object(events[e])])) as Record<
        string,
        z.ZodObject
      >
    )
    .patch(Object.fromEntries(names.map((e) => [e, () => ({})])))
    .on({ [`${name}_join`]: z.object({}) })
    .emit(() => [names[0], {}]);
  return (snap ? builder.snap(() => true) : builder).build();
};

const Counter = member(
  "Counter",
  { Counted: { by: z.number() } },
  { snap: true }
);

describe("a sensitive state with .snap()", () => {
  it("throws at build, naming only the offending state and every sensitive event", () => {
    const Offender = member(
      "Offender",
      {
        Registered: { email: sensitive(z.string()) },
        Renamed: { name: sensitive(z.string()) },
      },
      { snap: true }
    );
    expect(() => act().withState(Counter).withState(Offender).build()).toThrow(
      /^State "Offender" cannot snapshot — events \{Registered, Renamed\} carry sensitive fields/
    );
  });

  it("builds a sensitive state without .snap(), and a plain state with it", () => {
    const User = member("User", {
      Registered: { email: sensitive(z.string()) },
    });
    expect(() =>
      act().withState(User).withState(Counter).build()
    ).not.toThrow();
  });
});

/**
 * A sensitive field reads as "[REDACTED]" or "[SHREDDED]" to a caller who
 * may not see it, and so does any state field a reducer copies it into. The
 * first build names each such event field, and each state field of the same
 * name, whose type isn't a string, once.
 */
describe("the sensitive-type advisory", () => {
  const advisories = () => {
    const warn = vi.spyOn(log(), "warn").mockImplementation(() => {});
    return () =>
      warn.mock.calls
        .map(([message]) => String(message))
        .filter((m) =>
          m.includes("sensitive field(s) whose type isn't a string")
        );
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose()();
  });

  it("names nothing when every sensitive field is a string", () => {
    const read = advisories();
    act()
      .withState(
        member(
          "Member",
          {
            Joined: {
              email: sensitive(z.email()),
              name: sensitive(z.string().optional()),
              note: sensitive(z.string().nullable().default(null)),
              slug: sensitive(z.string().transform((s) => s.trim())),
              points: z.number(),
            },
          },
          { shape: { email: z.string(), points: z.number() } }
        )
      )
      .build();
    expect(read()).toEqual([]);
  });

  it("names a sensitive field that isn't a string, and the state field of its name", () => {
    const read = advisories();
    act()
      .withState(
        member(
          "Member",
          {
            Joined: {
              points: sensitive(z.number()),
              plan: sensitive(z.enum(["free", "pro"])),
              age: sensitive(z.string().pipe(z.coerce.number())),
              email: sensitive(z.string()),
            },
          },
          {
            shape: { points: z.number(), email: z.number(), score: z.number() },
          }
        )
      )
      .build();
    const [message] = read();
    expect(read()).toHaveLength(1);
    for (const field of [
      "Joined.points",
      "Member.points",
      "Joined.plan",
      "Joined.age",
      "Member.email",
    ])
      expect(message).toContain(field);
    expect(message).not.toContain("Joined.email");
    // Matched by name: a reducer copying `points` into `score` isn't found.
    expect(message).not.toContain("Member.score");
  });

  it("logs once per builder, however many apps it builds", () => {
    const read = advisories();
    const builder = act().withState(
      member("Member", { Joined: { points: sensitive(z.number()) } })
    );
    builder.build();
    builder.build();
    expect(read()).toHaveLength(1);
  });
});
