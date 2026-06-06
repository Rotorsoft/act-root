import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Actor,
  act,
  cache,
  dispose,
  REDACTED,
  SHREDDED,
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

// Owner-or-admin policy — typical real-world shape.
const User = state({ User: userSchema })
  .init(() => ({}))
  .emits({ UserRegistered: userRegisteredSchema })
  .patch({ UserRegistered: ({ data }) => ({ email: data.email }) })
  .on({ register: userRegisteredSchema })
  .emit((p) => ["UserRegistered", p])
  .discloses(
    (event, actor) =>
      actor.id === event.stream ||
      (Array.isArray(actor.roles) && actor.roles.includes("admin"))
  )
  .build();

// Same payload, but never declared a `.discloses` — framework default-deny.
const UserNoPolicy = state({ UserNoPolicy: userSchema })
  .init(() => ({}))
  .emits({ NoPolicyRegistered: userRegisteredSchema })
  .patch({ NoPolicyRegistered: ({ data }) => ({ email: data.email }) })
  .on({ register: userRegisteredSchema })
  .emit((p) => ["NoPolicyRegistered", p])
  .build();

const owner: Actor = { id: "user-1", name: "Ursula" };
const stranger: Actor = { id: "user-2", name: "Strange" };
const admin: Actor = {
  id: "admin-1",
  name: "Admin",
  roles: ["admin"],
} as Actor;

describe("read-path PII gate (#855 slice 4)", () => {
  afterEach(async () => {
    await dispose()();
  });

  // --- do() return is gated by target.actor ---

  it("owner registering themselves sees plaintext in the returned snapshot", async () => {
    const app = act().withState(User).build();
    const [snap] = await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    expect(snap.event?.data).toEqual({
      email: "u@example.com",
      name: "Ursula",
      plan: "free",
    });
  });

  it("admin registering someone else sees plaintext — predicate matches the roles branch", async () => {
    const app = act().withState(User).build();
    const [snap] = await app.do(
      "register",
      { stream: "user-1", actor: admin },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    expect(snap.event?.data).toEqual({
      email: "u@example.com",
      name: "Ursula",
      plan: "free",
    });
  });

  it("stranger registering user-1 sees REDACTED in the returned snapshot", async () => {
    const app = act().withState(User).build();
    const [snap] = await app.do(
      "register",
      { stream: "user-1", actor: stranger },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    expect(snap.event?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "pro",
    });
  });

  it("state without .discloses default-denies — REDACTED even when the actor 'should' see it", async () => {
    const app = act().withState(UserNoPolicy).build();
    const [snap] = await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    expect(snap.event?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "free",
    });
  });

  // --- load() is gated by actor parameter ---

  it("load with the owner actor sees plaintext (cache invalidated to force a fresh query)", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await cache().invalidate("user-1");
    const snap = await app.load(User, "user-1", undefined, undefined, owner);
    expect(snap.event?.data).toEqual({
      email: "u@example.com",
      name: "Ursula",
      plan: "free",
    });
  });

  it("load with a stranger actor sees REDACTED", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    await cache().invalidate("user-1");
    const snap = await app.load(User, "user-1", undefined, undefined, stranger);
    expect(snap.event?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "pro",
    });
  });

  it("load with no actor default-denies", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await cache().invalidate("user-1");
    const snap = await app.load(User, "user-1");
    expect(snap.event?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "free",
    });
  });

  // --- SHREDDED — irrecoverable post-forget ---

  it("after Store.forget_pii, reads return SHREDDED regardless of authorization", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    // Forget at the Store level — the orchestrator's app.forget wrapper lands
    // in slice 7. Slice 4 only needs to verify the gate substitutes SHREDDED
    // when the underlying pii column is gone.
    await store().forget_pii?.("user-1");
    await cache().invalidate("user-1");
    const snapOwner = await app.load(
      User,
      "user-1",
      undefined,
      undefined,
      owner
    );
    expect(snapOwner.event?.data).toEqual({
      email: SHREDDED,
      name: SHREDDED,
      plan: "pro",
    });
    await cache().invalidate("user-1");
    const snapAdmin = await app.load(
      User,
      "user-1",
      undefined,
      undefined,
      admin
    );
    expect(snapAdmin.event?.data).toEqual({
      email: SHREDDED,
      name: SHREDDED,
      plan: "pro",
    });
  });

  // --- Reducer always sees plaintext, even when external gate redacts ---

  it("reducer sees plaintext — derived state stays correct under external redaction", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "real@example.com", name: "Ursula", plan: "free" }
    );
    await cache().invalidate("user-1");
    // Load as a stranger. The external view of the event is REDACTED, but the
    // reducer-derived state (which the reducer copies from event.data.email)
    // should still hold the plaintext — verifies the reducer saw the merged
    // view, not the gated one.
    const snap = await app.load(User, "user-1", undefined, undefined, stranger);
    expect(snap.state).toEqual({ email: "real@example.com" });
    expect(snap.event?.data.email).toBe(REDACTED);
  });

  // --- Non-sensitive events: zero-cost passthrough ---

  it("non-sensitive events pass through unchanged on both do() and load()", async () => {
    const counterSchema = z.object({ count: z.number() });
    const Counter = state({ Counter: counterSchema })
      .init(() => ({ count: 0 }))
      .emits({ Incremented: z.object({ by: z.number() }) })
      .patch({
        Incremented: ({ data }, s) => ({ count: s.count + data.by }),
      })
      .on({ increment: z.object({ by: z.number() }) })
      .emit((p) => ["Incremented", p])
      .build();
    const app = act().withState(Counter).build();
    const [doSnap] = await app.do(
      "increment",
      { stream: "c-1", actor: owner },
      { by: 5 }
    );
    expect(doSnap.event?.data).toEqual({ by: 5 });
    expect(doSnap.state).toEqual({ count: 5 });
    await cache().invalidate("c-1");
    const loadSnap = await app.load(Counter, "c-1");
    expect(loadSnap.event?.data).toEqual({ by: 5 });
    expect(loadSnap.state).toEqual({ count: 5 });
  });
});
