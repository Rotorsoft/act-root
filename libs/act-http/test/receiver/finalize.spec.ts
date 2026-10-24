import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { describe, expect, it, vi } from "vitest";
import { make_idempotency } from "../../src/receiver/finalize.js";

describe("make_idempotency", () => {
  it("commit promotes a tentative claim to durable", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("k")).toBe(true);
    const { commit } = make_idempotency(store, { key: "k", deduped: false });
    commit();
    expect(store.claim("k")).toBe(false);
  });

  it("release drops a tentative claim so a retry re-processes", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("k")).toBe(true);
    const { release } = make_idempotency(store, { key: "k", deduped: false });
    release();
    expect(store.claim("k")).toBe(true);
  });

  it("finalizes once — a second commit/release after the first is a no-op", async () => {
    const store = {
      claim: vi.fn(() => true),
      commit: vi.fn(),
      release: vi.fn(),
    };
    const { commit, release } = make_idempotency(store, {
      key: "k",
      deduped: false,
    });
    await commit();
    await commit();
    await release();
    expect(store.commit).toHaveBeenCalledTimes(1);
    expect(store.release).not.toHaveBeenCalled();
  });

  it("is inert when the delivery is already deduped — never touches the store", async () => {
    const store = {
      claim: vi.fn(() => false),
      commit: vi.fn(),
      release: vi.fn(),
    };
    const { commit, release } = make_idempotency(store, {
      key: "k",
      deduped: true,
    });
    await commit();
    await release();
    // A duplicate must never commit or release someone else's claim.
    expect(store.commit).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
});
