import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Actor,
  act,
  type Committed,
  dispose,
  projection,
  sensitive,
  state,
  store,
} from "../src/index.js";

const userSchema = z.object({
  email: z.string().optional(),
  plan: z.enum(["free", "pro"]).optional(),
});

const UserRegistered = z.object({
  email: sensitive(z.string()),
  name: sensitive(z.string()),
  plan: z.enum(["free", "pro"]),
});

const User = state({ User: userSchema })
  .init(() => ({}))
  .emits({ UserRegistered })
  .patch({ UserRegistered: ({ data }) => ({ email: data.email }) })
  .on({ register: UserRegistered })
  .emit((p) => ["UserRegistered", p])
  .discloses(() => true) // allow plaintext through the gate, isolate the handler strip
  .build();

const actor: Actor = { id: "u-1", name: "Tester" };

describe("handler-side PII strip (#855 slice 5)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("reaction handler receives the event with sensitive keys removed AND no pii field", async () => {
    let seen: Committed<any, string> | undefined;
    async function onRegistered(event: Committed<any, string>) {
      seen = event;
    }
    const app = act()
      .withState(User)
      .on("UserRegistered")
      .do(onRegistered)
      .to(() => ({ target: "audit" }))
      .build();
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await app.correlate();
    await app.drain();
    expect(seen).toBeDefined();
    // Sensitive keys are GONE — not REDACTED, structurally absent.
    expect(seen!.data).toEqual({ plan: "free" });
    expect("email" in (seen!.data as object)).toBe(false);
    expect("name" in (seen!.data as object)).toBe(false);
    // The `pii` carrier is also dropped — handlers can't observe it.
    expect((seen as { pii?: unknown }).pii).toBeUndefined();
  });

  it("projection batch handler receives stripped events", async () => {
    const seen: Committed<any, string>[] = [];
    async function noop() {}
    async function captureBatch(events: readonly Committed<any, string>[]) {
      seen.push(...events);
    }
    const Roster = projection("user-roster")
      .on({ UserRegistered })
      .do(noop)
      .batch(captureBatch)
      .build();
    const app = act().withState(User).withProjection(Roster).build();
    await app.do(
      "register",
      { stream: "user-1", actor },
      { email: "u@example.com", name: "Ursula", plan: "free" }
    );
    await app.do(
      "register",
      { stream: "user-2", actor },
      { email: "v@example.com", name: "Vera", plan: "pro" }
    );
    await app.correlate();
    await app.drain();
    expect(seen).toHaveLength(2);
    for (const event of seen) {
      expect(event.data).not.toHaveProperty("email");
      expect(event.data).not.toHaveProperty("name");
      expect((event as { pii?: unknown }).pii).toBeUndefined();
    }
    expect(seen.map((e) => (e.data as { plan: string }).plan).sort()).toEqual([
      "free",
      "pro",
    ]);
  });

  it("defensive: sensitive keys still on event.data (e.g. bypassing the commit-split) get stripped", async () => {
    // Slice 3 normally moves sensitive keys to event.pii before commit, so
    // the reaction sees event.data already clean. This test bypasses that by
    // committing directly through `store()` with a sensitive key still on
    // .data — the strip must remove it regardless.
    let seen: Committed<any, string> | undefined;
    async function onRegistered(event: Committed<any, string>) {
      seen = event;
    }
    const app = act()
      .withState(User)
      .on("UserRegistered")
      .do(onRegistered)
      .to(() => ({ target: "audit-defensive" }))
      .build();
    // Bypass the orchestrator's split — commit with the sensitive keys still
    // present on data. Mirrors what a misuse of the raw Store would produce.
    await store().commit(
      "user-9",
      [
        {
          name: "UserRegistered",
          data: { email: "x@y.com", name: "X", plan: "free" } as any,
        },
      ],
      { correlation: "test-corr", causation: {} }
    );
    await app.correlate();
    await app.drain();
    expect(seen).toBeDefined();
    expect(seen!.data).toEqual({ plan: "free" });
    expect("email" in (seen!.data as object)).toBe(false);
    expect("name" in (seen!.data as object)).toBe(false);
  });

  it("non-sensitive events pass through unchanged to reaction handlers (zero-cost path)", async () => {
    let seen: Committed<any, string> | undefined;
    const counterSchema = z.object({ count: z.number() });
    const Incremented = z.object({ by: z.number() });
    const Counter = state({ Counter: counterSchema })
      .init(() => ({ count: 0 }))
      .emits({ Incremented })
      .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
      .on({ increment: Incremented })
      .emit((p) => ["Incremented", p])
      .build();
    async function onIncremented(event: Committed<any, string>) {
      seen = event;
    }
    const app = act()
      .withState(Counter)
      .on("Incremented")
      .do(onIncremented)
      .to(() => ({ target: "audit" }))
      .build();
    await app.do("increment", { stream: "c-1", actor }, { by: 5 });
    await app.correlate();
    await app.drain();
    expect(seen?.data).toEqual({ by: 5 });
  });
});
