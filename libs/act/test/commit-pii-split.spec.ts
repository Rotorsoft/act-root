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

const User = state({ User: userSchema })
  .init(() => ({}))
  .emits({ UserRegistered: userRegisteredSchema })
  .patch({ UserRegistered: ({ data }) => ({ email: data.email }) })
  .on({ register: userRegisteredSchema })
  .emit((payload) => ["UserRegistered", payload])
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

  it("the snapshot returned to .do() carries the split data (post-split shape)", async () => {
    const app = act().withState(User).build();
    const [snapshot] = await app.do(
      "register",
      { stream: "user-2", actor },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    expect(snapshot.event?.data).toEqual({ plan: "pro" });
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
