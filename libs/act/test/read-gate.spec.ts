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
  name: z.string().optional(),
  plan: z.enum(["free", "pro"]).optional(),
});

const userRegisteredSchema = z.object({
  email: sensitive(z.string()),
  name: sensitive(z.string()),
  plan: z.enum(["free", "pro"]),
});

// Owner-or-admin policy — typical real-world shape. The reducer copies
// both sensitive event fields into state so the load-path mask (#861)
// exercises its multi-match path.
const User = state({ User: userSchema })
  .init(() => ({}))
  .emits({ UserRegistered: userRegisteredSchema })
  .patch({
    UserRegistered: ({ data }) => ({ email: data.email, name: data.name }),
  })
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

// No sensitive fields at all — must pass through every gate untouched.
const Plain = state({ Plain: z.object({ n: z.number().optional() }) })
  .init(() => ({}))
  .emits({ Pinged: z.object({}) })
  .patch({ Pinged: () => ({}) })
  .on({ ping: z.object({}) })
  .emit(() => ["Pinged", {}])
  .build();

const owner: Actor = { id: "user-1", name: "Ursula" };
const stranger: Actor = { id: "user-2", name: "Strange" };
const admin: Actor = {
  id: "admin-1",
  name: "Admin",
  roles: ["admin"],
} as Actor;

describe("read-path PII gate", () => {
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

  it("do() returns plaintext to the emitter regardless of .discloses — actor IS the source", async () => {
    // The action handler runs against payload the caller just sent.
    // No view gate on the return path — the caller already has the
    // plaintext they submitted. .discloses governs reads (load/query),
    // not writes; redacting a freshly-emitted event back to its
    // originator would be theater.
    const app = act().withState(User).build();
    const [snap] = await app.do(
      "register",
      { stream: "user-1", actor: stranger },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    expect(snap.event?.data).toEqual({
      email: "u@example.com",
      name: "Ursula",
      plan: "pro",
    });
  });

  it("do() on a state without .discloses also returns plaintext — same rationale", async () => {
    const app = act().withState(UserNoPolicy).build();
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

  // --- load() is gated by actor parameter ---

  it("load with the owner actor sees plaintext (cache invalidated to force a fresh query)", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await cache().invalidate("user-1");
    const snap = await app.load(User, { stream: "user-1", actor: owner });
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
    const snap = await app.load(User, { stream: "user-1", actor: stranger });
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

  it("the gated load event drops the pii sidecar — plaintext never rides in event.pii", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await cache().invalidate("user-1");
    // Unauthorized: data redacted AND no sidecar.
    const denied = await app.load(User, { stream: "user-1", actor: stranger });
    expect((denied.event as { pii?: unknown }).pii).toBeUndefined();
    await cache().invalidate("user-1");
    // Authorized: plaintext merged into data, still no raw sidecar.
    const allowed = await app.load(User, { stream: "user-1", actor: owner });
    expect(allowed.event?.data.email).toBe("u@example.com");
    expect((allowed.event as { pii?: unknown }).pii).toBeUndefined();
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
    const snapOwner = await app.load(User, { stream: "user-1", actor: owner });
    expect(snapOwner.event?.data).toEqual({
      email: SHREDDED,
      name: SHREDDED,
      plan: "pro",
    });
    await cache().invalidate("user-1");
    const snapAdmin = await app.load(User, { stream: "user-1", actor: admin });
    expect(snapAdmin.event?.data).toEqual({
      email: SHREDDED,
      name: SHREDDED,
      plan: "pro",
    });
  });

  // --- Reducer sees plaintext (deterministic state evolution), but the
  //     load-path actor mask (#861) substitutes REDACTED for state fields
  //     whose names match a sensitive event field when the caller isn't
  //     authorized. Best-effort name-match — see `pii_mask_state`.

  it("reducer sees plaintext; load-path mask redacts state for unauthorized actors", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "real@example.com", name: "Ursula", plan: "free" }
    );
    // The reducer runs against the actor-gated view, so state mirrors
    // what the calling actor sees. Owner is authorized → plaintext in
    // state and event. Stranger is not → REDACTED in both.
    await cache().invalidate("user-1");
    const snapOwner = await app.load(User, { stream: "user-1", actor: owner });
    expect(snapOwner.state).toEqual({
      email: "real@example.com",
      name: "Ursula",
    });
    expect(snapOwner.event?.data.email).toBe("real@example.com");
    await cache().invalidate("user-1");
    const snapStranger = await app.load(User, {
      stream: "user-1",
      actor: stranger,
    });
    expect(snapStranger.state).toEqual({ email: REDACTED, name: REDACTED });
    expect(snapStranger.event?.data.email).toBe(REDACTED);
  });

  // --- Pii-aware state with a non-sensitive event mixed in ---
  // Exercises the `fields_by_event.get(name) ?? []` fallback in
  // `state.view`'s IDENTITY_GATE fallback for the non-sensitive event.

  it("pii-aware state with a non-sensitive event — load() passes it through unchanged", async () => {
    const registeredSchema = z.object({
      email: sensitive(z.string()),
      name: sensitive(z.string()),
      plan: z.enum(["free", "pro"]),
    });
    const promotedSchema = z.object({ plan: z.enum(["free", "pro"]) });
    const MixedUser = state({ MixedUser: userSchema })
      .init(() => ({}))
      .emits({
        UserRegistered2: registeredSchema,
        UserPromoted: promotedSchema,
      })
      .patch({
        UserRegistered2: ({ data }) => ({ email: data.email, name: data.name }),
        UserPromoted: ({ data }, s) => ({ ...s, plan: data.plan }),
      })
      .on({ register: registeredSchema })
      .emit((action) => ["UserRegistered2", action])
      .on({ promote: promotedSchema })
      .emit((action) => ["UserPromoted", action])
      .discloses(() => true)
      .build();
    const app = act().withState(MixedUser).build();
    await app.do(
      "register",
      { stream: "u-mix", actor: owner },
      { email: "m@example.com", name: "Mira", plan: "free" }
    );
    await app.do("promote", { stream: "u-mix", actor: owner }, { plan: "pro" });
    await cache().invalidate("u-mix");
    const snap = await app.load(MixedUser, { stream: "u-mix", actor: owner });
    // The last event is non-sensitive — view's fallback path hits the
    // empty-fields short-circuit and returns the event unchanged.
    expect(snap.event?.name).toBe("UserPromoted");
    expect(snap.event?.data).toEqual({ plan: "pro" });
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

// --- query / query_array carry no actor → default-deny, mirroring a
//     bare-string load. The store returns the raw pii column; the gate
//     lives in the orchestrator (#1277). ---

describe("query / query_array default-deny PII gate", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("query_array redacts sensitive fields and drops the pii sidecar — even with a permissive .discloses", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    const events = await app.query_array({
      stream: "user-1",
      stream_exact: true,
    });
    const reg = events.find((e) => e.name === "UserRegistered");
    expect(reg?.data).toEqual({ email: REDACTED, name: REDACTED, plan: "pro" });
    // The isolated pii sidecar must not ride along.
    expect((reg as { pii?: unknown }).pii).toBeUndefined();
  });

  it("query (streaming callback) redacts + drops the sidecar too", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    let seen: { data?: Record<string, unknown>; pii?: unknown } | undefined;
    const { first } = await app.query(
      { stream: "user-1", stream_exact: true },
      (e) => {
        if (e.name === "UserRegistered") seen = e;
      }
    );
    expect(seen?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "free",
    });
    expect(seen?.pii).toBeUndefined();
    // `first`/`last` returned to the caller are gated too.
    expect((first as { data?: { email?: string } })?.data?.email).toBe(
      REDACTED
    );
  });

  it("a default-deny state (no .discloses) is redacted on query too", async () => {
    const app = act().withState(UserNoPolicy).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    const events = await app.query_array({
      stream: "user-1",
      stream_exact: true,
    });
    const reg = events.find((e) => e.name === "NoPolicyRegistered");
    expect(reg?.data.email).toBe(REDACTED);
  });

  it("after forget_pii, query returns SHREDDED", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    await store().forget_pii?.("user-1");
    const events = await app.query_array({
      stream: "user-1",
      stream_exact: true,
    });
    const reg = events.find((e) => e.name === "UserRegistered");
    expect(reg?.data).toEqual({
      email: SHREDDED,
      name: SHREDDED,
      plan: "pro",
    });
  });

  it("non-sensitive events pass through query unchanged", async () => {
    const Counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Incremented: z.object({ by: z.number() }) })
      .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
      .on({ increment: z.object({ by: z.number() }) })
      .emit((p) => ["Incremented", p])
      .build();
    const app = act().withState(Counter).build();
    await app.do("increment", { stream: "c-1", actor: owner }, { by: 5 });
    const [e] = await app.query_array({ stream: "c-1", stream_exact: true });
    expect(e.data).toEqual({ by: 5 });
  });

  it("mixed stream: query gates only the sensitive event, passes the non-sensitive one through", async () => {
    // The crux of the prebuilt-gate design — in an app that DOES declare
    // sensitive events, a non-sensitive event on the same stream resolves to
    // the shared IDENTITY_GATE and is handed back untouched; only the
    // sensitive event pays the redaction.
    const registeredSchema = z.object({
      email: sensitive(z.string()),
      name: sensitive(z.string()),
      plan: z.enum(["free", "pro"]),
    });
    const promotedSchema = z.object({ plan: z.enum(["free", "pro"]) });
    const MixedUser = state({ MixedUser: userSchema })
      .init(() => ({}))
      .emits({
        UserRegistered3: registeredSchema,
        UserPromoted3: promotedSchema,
      })
      .patch({
        UserRegistered3: ({ data }) => ({ email: data.email, name: data.name }),
        UserPromoted3: ({ data }, s) => ({ ...s, plan: data.plan }),
      })
      .on({ register: registeredSchema })
      .emit((p) => ["UserRegistered3", p])
      .on({ promote: promotedSchema })
      .emit((p) => ["UserPromoted3", p])
      .discloses(() => true)
      .build();
    const app = act().withState(MixedUser).build();
    await app.do(
      "register",
      { stream: "u-mix", actor: owner },
      { email: "m@example.com", name: "Mira", plan: "free" }
    );
    await app.do("promote", { stream: "u-mix", actor: owner }, { plan: "pro" });
    const events = await app.query_array({
      stream: "u-mix",
      stream_exact: true,
    });
    // Sensitive event redacted despite the permissive `.discloses` — query is
    // actor-less, so default-deny.
    const registered = events.find((e) => e.name === "UserRegistered3");
    expect(registered?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "free",
    });
    // Non-sensitive event passes through — same object, untouched.
    const promoted = events.find((e) => e.name === "UserPromoted3");
    expect(promoted?.data).toEqual({ plan: "pro" });
  });
});

describe("drain() default-deny PII gate", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("Drain.fetched redacts sensitive fields and drops the pii sidecar", async () => {
    const app = act()
      .withState(User)
      .on("UserRegistered")
      .do(async function noop() {})
      .to(() => ({ target: "audit" }))
      .build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    await app.correlate();
    const { fetched } = await app.drain();

    const event = fetched.flatMap((f) => f.events).at(0);
    expect(event?.name).toBe("UserRegistered");
    expect(event?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "pro",
    });
    expect((event as { pii?: unknown }).pii).toBeUndefined();
  });

  it("a default-deny state (no .discloses) is redacted on drain too", async () => {
    const app = act()
      .withState(UserNoPolicy)
      .on("NoPolicyRegistered")
      .do(async function noop2() {})
      .to(() => ({ target: "audit" }))
      .build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await app.correlate();
    const { fetched } = await app.drain();

    const event = fetched.flatMap((f) => f.events).at(0);
    expect(event?.data).toEqual({
      email: REDACTED,
      name: REDACTED,
      plan: "free",
    });
    expect((event as { pii?: unknown }).pii).toBeUndefined();
  });

  it("the handler still receives plaintext — only the returned view is gated", async () => {
    const seen: unknown[] = [];
    const app = act()
      .withState(User)
      .on("UserRegistered")
      .do(async function record(e) {
        seen.push(e.data);
      })
      .to(() => ({ target: "audit" }))
      .build();
    await app.do(
      "register",
      { stream: "user-1", actor: owner },
      { email: "u@example.com", name: "Ursula", plan: "pro" }
    );
    await app.correlate();
    await app.drain();
    // Handlers read through their own strip: sensitive keys removed, never
    // REDACTED placeholders, and never a pii sidecar.
    expect(seen).toEqual([{ plan: "pro" }]);
  });

  it("non-sensitive events pass through drain unchanged", async () => {
    const app = act()
      .withState(Plain)
      .on("Pinged")
      .do(async function noop3() {})
      .to(() => ({ target: "audit" }))
      .build();
    await app.do("ping", { stream: "p-1", actor: owner }, {});
    await app.correlate();
    const { fetched } = await app.drain();
    expect(fetched.flatMap((f) => f.events).at(0)?.data).toEqual({});
  });
});
