import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { describe, expect, it, vi } from "vitest";
import { withIdempotency } from "../../src/api/index.js";

const makeStore = (
  claimImpl: IdempotencyStore["claim"]
): IdempotencyStore & {
  commit: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} => ({
  claim: vi.fn<IdempotencyStore["claim"]>(claimImpl),
  commit: vi.fn<IdempotencyStore["commit"]>(),
  release: vi.fn<IdempotencyStore["release"]>(),
});

describe("withIdempotency", () => {
  it("runs the handler and returns the result on a fresh claim", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, snapshot: 7 });
    const store = makeStore(() => true);

    const out = await withIdempotency(store, "key-1", handler);

    expect(out).toEqual({ deduped: false, result: { ok: true, snapshot: 7 } });
    expect(vi.mocked(store.claim)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.claim)).toHaveBeenCalledWith("key-1");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("commits the key after the handler succeeds", async () => {
    const handler = vi.fn().mockResolvedValue("done");
    const store = makeStore(() => true);

    await withIdempotency(store, "key-commit", handler);

    expect(store.commit).toHaveBeenCalledTimes(1);
    expect(store.commit).toHaveBeenCalledWith("key-commit");
    expect(store.release).not.toHaveBeenCalled();
  });

  it("skips the handler and returns { deduped: true } on a duplicate claim", async () => {
    const handler = vi.fn().mockResolvedValue("never returned");
    const store = makeStore(() => false);

    const out = await withIdempotency(store, "key-1", handler);

    expect(out).toEqual({ deduped: true });
    expect(vi.mocked(store.claim)).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("awaits an async claim implementation", async () => {
    const handler = vi.fn().mockResolvedValue("ran");
    const store = makeStore(async () => true);

    const out = await withIdempotency(store, "key-async", handler);

    expect(out).toEqual({ deduped: false, result: "ran" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("awaits an async claim that reports duplicate", async () => {
    const handler = vi.fn();
    const store = makeStore(async () => false);

    const out = await withIdempotency(store, "key-async-dup", handler);

    expect(out).toEqual({ deduped: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("releases the key and propagates handler rejections after a fresh claim", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("handler boom"));
    const store = makeStore(() => true);

    await expect(withIdempotency(store, "key-throw", handler)).rejects.toThrow(
      "handler boom"
    );
    expect(vi.mocked(store.claim)).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    // Released so a retry re-processes; never committed.
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledWith("key-throw");
    expect(store.commit).not.toHaveBeenCalled();
  });
});
