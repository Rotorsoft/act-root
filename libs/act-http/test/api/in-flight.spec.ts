import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { describe, expect, it } from "vitest";
import { track_in_flight } from "../../src/api/in-flight.js";

describe("track_in_flight", () => {
  it("counts a won claim until it is committed", async () => {
    const t = track_in_flight(new InMemoryIdempotencyStore());
    expect(await t.store.claim("k")).toBe(true);
    expect(t.in_flight("k")).toBe(true);
    await t.store.commit("k");
    expect(t.in_flight("k")).toBe(false);
  });

  it("counts a won claim until it is released", async () => {
    const t = track_in_flight(new InMemoryIdempotencyStore());
    await t.store.claim("k");
    await t.store.release("k");
    expect(t.in_flight("k")).toBe(false);
  });

  it("a losing claim uncounts itself and leaves the winner counted", async () => {
    const t = track_in_flight(new InMemoryIdempotencyStore());
    await t.store.claim("k");
    expect(await t.store.claim("k")).toBe(false);
    expect(t.in_flight("k")).toBe(true);
    await t.store.commit("k");
    expect(t.in_flight("k")).toBe(false);
    // a duplicate of the committed key is not in flight
    expect(await t.store.claim("k")).toBe(false);
    expect(t.in_flight("k")).toBe(false);
  });

  it("sees the winner when an async store answers the loser first", async () => {
    // The winner's claim lands in the store at once, but its reply is slow.
    const inner = new InMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      claim: async (k) => {
        const won = inner.claim(k);
        if (won) await new Promise((r) => setTimeout(r, 20));
        return won;
      },
      commit: (k) => inner.commit(k),
      release: (k) => inner.release(k),
    };
    const t = track_in_flight(store);
    const winner = t.store.claim("k");
    expect(await t.store.claim("k")).toBe(false);
    expect(t.in_flight("k")).toBe(true);
    expect(await winner).toBe(true);
    await t.store.release("k");
    expect(t.in_flight("k")).toBe(false);
  });

  it("uncounts a claim that throws synchronously", () => {
    const t = track_in_flight({
      claim: () => {
        throw new Error("store down");
      },
      commit: () => {},
      release: () => {},
    });
    expect(() => t.store.claim("k")).toThrow("store down");
    expect(t.in_flight("k")).toBe(false);
  });

  it("uncounts a claim whose promise rejects", async () => {
    const t = track_in_flight({
      claim: async () => {
        throw new Error("store down");
      },
      commit: () => {},
      release: () => {},
    });
    await expect(t.store.claim("k")).rejects.toThrow("store down");
    expect(t.in_flight("k")).toBe(false);
  });

  it("a commit of a never-claimed key does not leave a count behind", async () => {
    // The port lets a caller commit a key it never claimed (a durable
    // adapter recovering a lost reservation); that must not go negative
    // and hide a later real claim.
    const t = track_in_flight(new InMemoryIdempotencyStore());
    await t.store.commit("never");
    expect(t.in_flight("never")).toBe(false);
    await t.store.release("other");
    expect(await t.store.claim("other")).toBe(true);
    expect(t.in_flight("other")).toBe(true);
  });

  it("uncounts even when commit throws", async () => {
    const inner = new InMemoryIdempotencyStore();
    const t = track_in_flight({
      claim: (k) => inner.claim(k),
      commit: () => {
        throw new Error("commit failed");
      },
      release: (k) => inner.release(k),
    });
    await t.store.claim("k");
    await expect(t.store.commit("k")).rejects.toThrow("commit failed");
    expect(t.in_flight("k")).toBe(false);
  });
});
