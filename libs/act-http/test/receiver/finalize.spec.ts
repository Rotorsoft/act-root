import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { describe, expect, it, vi } from "vitest";
import { make_finalizers } from "../../src/receiver/finalize.js";

describe("make_finalizers", () => {
  it("commit promotes a tentative claim to durable", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("k")).toBe(true);
    const { commit } = make_finalizers(store, "k", false);
    commit();
    expect(store.claim("k")).toBe(false);
  });

  it("release drops a tentative claim so a retry re-processes", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("k")).toBe(true);
    const { release } = make_finalizers(store, "k", false);
    release();
    expect(store.claim("k")).toBe(true);
  });

  it("finalizes once — a second commit/release after the first is a no-op", async () => {
    const store = {
      claim: vi.fn(() => true),
      commit: vi.fn(),
      release: vi.fn(),
    };
    const { commit, release } = make_finalizers(store, "k", false);
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
    const { commit, release } = make_finalizers(store, "k", true);
    await commit();
    await release();
    // A duplicate must never commit or release someone else's claim.
    expect(store.commit).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
});
