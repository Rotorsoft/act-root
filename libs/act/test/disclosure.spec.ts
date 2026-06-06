import { describe, expect, it } from "vitest";
import { z } from "zod";
import { act, sensitive, state, ZodEmpty } from "../src/index.js";

// Realistic shape for the sensitive-data foundation tests: a state whose
// emitted event carries two sensitive fields and one non-sensitive field,
// with a state-level disclosure predicate (owner OR admin).

const userSchema = z.object({
  email: z.string().optional(),
  plan: z.enum(["free", "pro"]).optional(),
});

const userRegisteredSchema = z.object({
  email: sensitive(z.string()),
  name: sensitive(z.string()),
  plan: z.enum(["free", "pro"]),
});

const User = state({ User: userSchema })
  .init(() => ({}))
  .emits({ UserRegistered: userRegisteredSchema })
  .patch({ UserRegistered: ({ data }) => ({ email: data.email }) })
  .on({ register: userRegisteredSchema })
  .emit((payload) => ["UserRegistered", payload])
  .discloses(
    (event, actor) =>
      actor.id === event.stream ||
      (Array.isArray(actor.roles) && actor.roles.includes("admin"))
  )
  .build();

const Plain = state({ Plain: userSchema })
  .init(() => ({}))
  .emits({ Pinged: ZodEmpty })
  .patch({ Pinged: () => ({}) })
  .on({ ping: ZodEmpty })
  .emit(() => ["Pinged", {}])
  .build();

describe("state(...).discloses()", () => {
  it("registers the predicate on the built state", () => {
    expect(User.disclose).toBeTypeOf("function");
  });

  it("is absent when never called — default-deny on read", () => {
    expect(Plain.disclose).toBeUndefined();
  });

  it("overrides on a second call (state-level semantics)", () => {
    const builder = state({ X: userSchema })
      .init(() => ({}))
      .emits({ XHappened: userRegisteredSchema })
      .patch({ XHappened: () => ({}) })
      .on({ xdo: userRegisteredSchema })
      .emit((p) => ["XHappened", p])
      .discloses(() => true)
      .discloses(() => false);
    const built = builder.build();
    expect(
      built.disclose?.(
        {
          id: 0,
          stream: "x",
          version: 0,
          created: new Date(),
          name: "XHappened",
          data: { email: "a", name: "b", plan: "free" },
          meta: {} as any,
        },
        { id: "any", name: "any" }
      )
    ).toBe(false);
  });
});

describe("registry.sensitive_fields", () => {
  it("returns the marked keys for an event with sensitive fields", () => {
    const app = act().withState(User).build();
    expect([...app.registry.sensitive_fields("UserRegistered")]).toEqual([
      "email",
      "name",
    ]);
  });

  it("returns an empty array for events with no sensitive fields", () => {
    const app = act().withState(Plain).build();
    expect(app.registry.sensitive_fields("Pinged")).toEqual([]);
  });

  it("returns an empty array for unknown event names — safe lookup", () => {
    const app = act().withState(Plain).build();
    expect(app.registry.sensitive_fields("NeverDeclared")).toEqual([]);
  });

  it("computes once at build, not per call — same array reference returned across calls", () => {
    const app = act().withState(User).build();
    const a = app.registry.sensitive_fields("UserRegistered");
    const b = app.registry.sensitive_fields("UserRegistered");
    expect(a).toBe(b);
  });
});

describe("registry.disclosure_predicate", () => {
  it("returns the predicate for a state that declared one", () => {
    const app = act().withState(User).build();
    const pred = app.registry.disclosure_predicate("User");
    expect(pred).toBeTypeOf("function");
    const event = {
      id: 0,
      stream: "user-123",
      version: 0,
      created: new Date(),
      name: "UserRegistered" as const,
      data: { email: "u@example.com", name: "Ursula", plan: "free" as const },
      meta: {} as any,
    };
    expect(pred?.(event, { id: "user-123", name: "Ursula" })).toBe(true);
    expect(pred?.(event, { id: "other", name: "Other" })).toBe(false);
    expect(
      pred?.(event, { id: "other", name: "Admin", roles: ["admin"] } as any)
    ).toBe(true);
  });

  it("returns null when the state did not declare a predicate (default-deny)", () => {
    const app = act().withState(Plain).build();
    expect(app.registry.disclosure_predicate("Plain")).toBeNull();
  });

  it("returns null for unknown state names — safe lookup", () => {
    const app = act().withState(User).build();
    expect(app.registry.disclosure_predicate("NeverDeclared")).toBeNull();
  });
});
