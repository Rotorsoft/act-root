import { describe, expect, it } from "vitest";
import { z } from "zod";
import { act, sensitive, state } from "../src/index.js";

const userSchema = z.object({ email: z.string().optional() });
const counterSchema = z.object({ count: z.number() });

const PIIEvent = z.object({
  email: sensitive(z.string()),
  name: sensitive(z.string()),
});

const NonPIIEvent = z.object({ by: z.number() });

describe("build-time snapshot validator (#855 slice 6)", () => {
  it("throws when a state declares both sensitive events and .snap()", () => {
    const Offender = state({ Offender: userSchema })
      .init(() => ({}))
      .emits({ PIIEvent })
      .patch({ PIIEvent: ({ data }) => ({ email: data.email }) })
      .on({ register: PIIEvent })
      .emit((p) => ["PIIEvent", p])
      .snap(() => true)
      .build();
    expect(() => act().withState(Offender).build()).toThrow(
      /State "Offender" cannot snapshot — events \{PIIEvent\} carry sensitive fields/
    );
  });

  it("error message lists every offending event name when more than one is sensitive", () => {
    const ManyEvents = z.object({
      a: sensitive(z.string()),
    });
    const Offender = state({ Offender: userSchema })
      .init(() => ({}))
      .emits({ PIIEvent, ManyEvents })
      .patch({
        PIIEvent: () => ({}),
        ManyEvents: () => ({}),
      })
      .on({ register: PIIEvent })
      .emit((p) => ["PIIEvent", p])
      .snap(() => true)
      .build();
    expect(() => act().withState(Offender).build()).toThrow(
      /events \{PIIEvent, ManyEvents\}/
    );
  });

  it("non-sensitive state with .snap() builds cleanly", () => {
    const Counter = state({ Counter: counterSchema })
      .init(() => ({ count: 0 }))
      .emits({ NonPIIEvent })
      .patch({
        NonPIIEvent: ({ data }, s) => ({ count: s.count + data.by }),
      })
      .on({ increment: NonPIIEvent })
      .emit((p) => ["NonPIIEvent", p])
      .snap(() => true)
      .build();
    expect(() => act().withState(Counter).build()).not.toThrow();
  });

  it("sensitive state without .snap() builds cleanly", () => {
    const User = state({ User: userSchema })
      .init(() => ({}))
      .emits({ PIIEvent })
      .patch({ PIIEvent: ({ data }) => ({ email: data.email }) })
      .on({ register: PIIEvent })
      .emit((p) => ["PIIEvent", p])
      .build();
    expect(() => act().withState(User).build()).not.toThrow();
  });

  it("with multiple states, the error names only the offending one", () => {
    const Counter = state({ Counter: counterSchema })
      .init(() => ({ count: 0 }))
      .emits({ NonPIIEvent })
      .patch({
        NonPIIEvent: ({ data }, s) => ({ count: s.count + data.by }),
      })
      .on({ increment: NonPIIEvent })
      .emit((p) => ["NonPIIEvent", p])
      .snap(() => true)
      .build();
    const PIIEventForOffender = z.object({
      email: sensitive(z.string()),
    });
    const Offender = state({ Offender: userSchema })
      .init(() => ({}))
      .emits({ PIIEventForOffender })
      .patch({ PIIEventForOffender: () => ({}) })
      .on({ register: PIIEventForOffender })
      .emit((p) => ["PIIEventForOffender", p])
      .snap(() => true)
      .build();
    expect(() => act().withState(Counter).withState(Offender).build()).toThrow(
      /State "Offender" cannot snapshot/
    );
  });
});
