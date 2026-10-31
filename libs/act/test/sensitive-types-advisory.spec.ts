import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, dispose, log, sensitive, state } from "../src/index.js";

/**
 * A sensitive field reads as "[REDACTED]" or "[SHREDDED]" to a caller who
 * may not see it, and so does any state field a reducer copies it into. The
 * first build names each such event field, and each state field of the same
 * name, whose type isn't a string, once.
 */

const advisories = () => {
  const warn = vi.spyOn(log(), "warn").mockImplementation(() => {});
  return () =>
    warn.mock.calls
      .map(([message]) => String(message))
      .filter((m) =>
        m.includes("sensitive field(s) whose type isn't a string")
      );
};

const member = (
  data: Record<string, z.ZodType>,
  state_shape: Record<string, z.ZodType> = {}
) =>
  state({ Member: z.object(state_shape) })
    .init(() => ({}))
    .emits({ Joined: z.object(data) })
    .patch({ Joined: (_e, s) => s })
    .on({ join: z.object({}) })
    .emit(() => ["Joined", {}])
    .build();

describe("the sensitive-type advisory", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose()();
  });

  it("names nothing when every sensitive field is a string", () => {
    const read = advisories();
    act()
      .withState(
        member(
          {
            email: sensitive(z.email()),
            name: sensitive(z.string().optional()),
            note: sensitive(z.string().nullable().default(null)),
            slug: sensitive(z.string().transform((s) => s.trim())),
            points: z.number(),
          },
          { email: z.string(), points: z.number() }
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
          {
            points: sensitive(z.number()),
            plan: sensitive(z.enum(["free", "pro"])),
            age: sensitive(z.string().pipe(z.coerce.number())),
            email: sensitive(z.string()),
          },
          { points: z.number(), email: z.number(), score: z.number() }
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
    const builder = act().withState(member({ points: sensitive(z.number()) }));
    builder.build();
    builder.build();
    expect(read()).toHaveLength(1);
  });
});
