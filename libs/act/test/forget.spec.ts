import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type Actor,
  act,
  cache,
  dispose,
  SHREDDED,
  sensitive,
  state,
  store,
} from "../src/index.js";

const userSchema = z.object({ email: z.string().optional() });
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
  .emit((p) => ["UserRegistered", p])
  .discloses(() => true)
  .build();

const actor: Actor = { id: "u-1", name: "Tester" };

describe("app.forget(stream) + forgotten lifecycle (#855 slice 7)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("happy path — wipes pii, returns the row count, emits forgotten once", async () => {
    const app = act().withState(User).build();
    const seen: { stream: string; at: Date; eventCount: number }[] = [];
    app.on("forgotten", (payload) => {
      seen.push(payload);
    });
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    const result = await app.forget("user-1");
    expect(result.eventCount).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].stream).toBe("user-1");
    expect(seen[0].eventCount).toBe(1);
    expect(seen[0].at).toBeInstanceOf(Date);
    // Reading the stream back returns SHREDDED for sensitive fields.
    const snap = await app.load(User, { stream: "user-1", actor: actor });
    expect(snap.event?.data).toEqual({
      email: SHREDDED,
      name: SHREDDED,
      plan: "free",
    });
  });

  it("idempotent — second call returns {eventCount: 0} and does NOT re-emit forgotten", async () => {
    const app = act().withState(User).build();
    const seen: { stream: string; at: Date; eventCount: number }[] = [];
    app.on("forgotten", (payload) => {
      seen.push(payload);
    });
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await app.forget("user-1");
    const second = await app.forget("user-1");
    expect(second.eventCount).toBe(0);
    expect(seen).toHaveLength(1); // not 2
  });

  it("invalidates the cache so the next load doesn't return stale PII", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    // Warm the cache with a load.
    await app.load(User, { stream: "user-1", actor: actor });
    // Spy on cache().invalidate to confirm forget triggers it.
    const spy = vi.spyOn(cache(), "invalidate");
    await app.forget("user-1");
    expect(spy).toHaveBeenCalledWith("user-1");
    spy.mockRestore();
  });

  it("throws on adapters without forget_pii — operator gets a clear signal", async () => {
    const app = act().withState(User).build();
    // Mock-strip the in-memory adapter's forget_pii to mimic an adapter that
    // doesn't declare pii_isolation. Using the same store() ref so the patch
    // takes effect for this app.
    const s = store() as { forget_pii?: unknown };
    const original = s.forget_pii;
    s.forget_pii = undefined; // shadow the prototype method
    try {
      await expect(app.forget("user-1")).rejects.toThrow(
        /Store does not implement forget_pii/
      );
    } finally {
      s.forget_pii = original;
    }
  });

  it("zero events on a stream that never had any — eventCount 0, no emit", async () => {
    const app = act().withState(User).build();
    const seen: unknown[] = [];
    app.on("forgotten", (p) => {
      seen.push(p);
    });
    const result = await app.forget("never-existed");
    expect(result.eventCount).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("pii-aware states never populate the snapshot cache (#861)", async () => {
    const app = act().withState(User).build();
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    // The reducer runs against the actor-gated event view, so derived
    // state varies by caller. Pii-aware states never cache to avoid
    // serving one actor's view to another. Verified pre-forget and
    // post-forget — the rule is build-time, not runtime.
    await app.load(User, { stream: "user-1", actor });
    expect(await cache().get("user-1")).toBeUndefined();
    await app.forget("user-1");
    await app.load(User, { stream: "user-1", actor });
    expect(await cache().get("user-1")).toBeUndefined();
  });

  it("cache.invalidate failure short-circuits forget and suppresses `forgotten` (#861)", async () => {
    const app = act().withState(User).build();
    const seen: unknown[] = [];
    app.on("forgotten", (p) => {
      seen.push(p);
    });
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    const spy = vi
      .spyOn(cache(), "invalidate")
      .mockRejectedValueOnce(new Error("cache adapter down"));
    await expect(app.forget("user-1")).rejects.toThrow("cache adapter down");
    expect(seen).toHaveLength(0);
    spy.mockRestore();
  });
});
