import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Actor,
  act,
  type Committed,
  dispose,
  type Schemas,
  sensitive,
  state,
  store,
} from "../src/index.js";

const userSchema = z.object({
  email: z.string().optional(),
  plan: z.enum(["free", "pro"]).optional(),
});

const userRegisteredSchema = z.object({
  email: sensitive(z.string()),
  name: sensitive(z.string()),
  plan: z.enum(["free", "pro"]),
});

// `.discloses(() => true)` is the simplest way to confirm the slice 3 split
// without slice 4's gate intervening — the test wants to verify the
// underlying split mechanic, not the read-time substitution.
const User = state({ User: userSchema })
  .init(() => ({}))
  .emits({ UserRegistered: userRegisteredSchema })
  .patch({ UserRegistered: ({ data }) => ({ email: data.email }) })
  .on({ register: userRegisteredSchema })
  .emit((payload) => ["UserRegistered", payload])
  .discloses(() => true)
  .build();

const counterSchema = z.object({ count: z.number() });
const Counter = state({ Counter: counterSchema })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((p) => ["Incremented", p])
  .build();

const actor: Actor = { id: "u-1", name: "Tester" };

async function collect(): Promise<Committed<Schemas, keyof Schemas>[]> {
  const out: Committed<Schemas, keyof Schemas>[] = [];
  await store().query((e) => {
    out.push(e);
  });
  return out;
}

describe("commit-path PII split (#855 slice 3)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("splits sensitive fields into events.pii — data carries only non-sensitive keys", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    const events = await collect();
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ plan: "free" });
    expect(events[0].pii).toEqual({ email: "u@example.com", name: "Ursula" });
  });

  it("zero-cost path — events with no sensitive fields are not split", async () => {
    const app = act().withState(Counter).build();
    await app.do("increment", { stream: "c-1", actor }, { by: 5 });
    const events = await collect();
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ by: 5 });
    // No pii Map entry was set on the store — InMemoryStore returns the event
    // without a `pii` field, which reads as undefined here.
    expect(events[0].pii).toBeUndefined();
  });

  it("the snapshot returned to .do() carries the gated event — split happens underneath", async () => {
    // User's `.discloses(() => true)` lets the actor see plaintext, so the
    // gate merges pii back into data on the returned snapshot. The split
    // is still real — the underlying store has data/pii separated (verified
    // by the first test) — the gate just reassembles for the authorized
    // caller's view.
    const app = act().withState(User).build();
    const [snapshot] = await app.do(
      "register",
      { stream: "user-2", actor },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    expect(snapshot.event?.data).toEqual({
      email: "u@example.com",
      name: "Ursula",
      plan: "pro",
    });
    expect(snapshot.event?.pii).toEqual({
      email: "u@example.com",
      name: "Ursula",
    });
  });

  it("when only some sensitive fields are present in the payload, only those move to pii", async () => {
    // Build a state whose schema marks both email and middleName as sensitive,
    // but middleName is optional — when omitted, it shouldn't appear in pii.
    const optionalSchema = z.object({
      email: sensitive(z.string()),
      middleName: sensitive(z.string()).optional(),
      plan: z.string(),
    });
    const Optional = state({ Optional: z.object({}) })
      .init(() => ({}))
      .emits({ OptionalEmitted: optionalSchema })
      .patch({ OptionalEmitted: () => ({}) })
      .on({ emit: optionalSchema })
      .emit((p) => ["OptionalEmitted", p])
      .build();
    const app = act().withState(Optional).build();
    await app.do(
      "emit",
      { stream: "o-1", actor },
      { email: "x@y.com", plan: "free" } // middleName omitted
    );
    const events = await collect();
    expect(events[0].data).toEqual({ plan: "free" });
    expect(events[0].pii).toEqual({ email: "x@y.com" });
  });
});

// #1417 — `sensitive()` registered the schema INSTANCE in a WeakMap, and Zod
// clones on every refinement, so `sensitive(z.string()).min(1)` silently lost
// its marker: plaintext into events.data, plaintext out of the default-deny
// read surface, and forget() reporting eventCount 0 while wiping nothing.
// One paren from the documented form, with no signal anywhere.
describe("sensitive() marker survival (#1417)", () => {
  const marker_actor = { id: "a", name: "a" };

  const build = (email: z.ZodType<string>) => {
    const registered = z.object({ email, plan: z.string() });
    return state({ M: z.object({ email: z.string(), plan: z.string() }) })
      .init(() => ({ email: "", plan: "" }))
      .emits({ MRegistered: registered })
      .patch({
        MRegistered: ({ data }) => ({ email: data.email, plan: data.plan }),
      })
      .on({ register: registered })
      .emit((p) => ["MRegistered", p])
      .build();
  };

  const split_for = async (email: z.ZodType<string>) => {
    const app = act().withState(build(email)).build();
    await app.do(
      "register",
      { stream: `m-${Math.random()}`, actor: marker_actor },
      { email: "alice@example.com", plan: "pro" }
    );
    const rows: { data: unknown; pii?: unknown }[] = [];
    await store().query((e) => rows.push(e as never));
    await app.shutdown();
    return rows[rows.length - 1];
  };

  afterEach(async () => {
    await dispose()();
  });

  it("survives a refinement chained after sensitive()", async () => {
    const row = await split_for(sensitive(z.string()).min(1));
    expect(row?.pii).toEqual({ email: "alice@example.com" });
    expect(row?.data).toEqual({ plan: "pro" });
  });

  it("survives .email(), .describe() and .refine() chains", async () => {
    for (const email of [
      sensitive(z.string()).email(),
      sensitive(z.string()).describe("the email"),
      sensitive(z.string()).refine((v) => v.length > 0),
    ]) {
      const row = await split_for(email as z.ZodType<string>);
      expect(row?.pii).toEqual({ email: "alice@example.com" });
    }
  });

  it("still works in the documented order", async () => {
    const row = await split_for(sensitive(z.string().min(1)));
    expect(row?.pii).toEqual({ email: "alice@example.com" });
  });

  it("splits pii declared inside a discriminated-union variant", async () => {
    const contacted = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("email"), email: sensitive(z.string()) }),
      z.object({ kind: z.literal("phone"), phone: z.string() }),
    ]);
    const U = state({ U: z.object({ seen: z.boolean() }) })
      .init(() => ({ seen: false }))
      .emits({ Contacted: contacted })
      .patch({ Contacted: () => ({ seen: true }) })
      .on({ contact: contacted })
      .emit((p) => ["Contacted", p])
      .build();
    const app = act().withState(U).build();
    await app.do("contact", { stream: "u-union", actor: marker_actor }, {
      kind: "email",
      email: "alice@example.com",
    } as never);
    const rows: { data: unknown; pii?: unknown }[] = [];
    await store().query((e) => rows.push(e as never), { stream: "u-union" });
    expect(rows[0]?.pii).toEqual({ email: "alice@example.com" });
    expect(rows[0]?.data).toEqual({ kind: "email" });
    await app.shutdown();
  });
});
