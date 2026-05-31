import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { webhookReceiver } from "../../../src/receiver/trpc/index.js";

const BODY = '{"orderId":"o-1"}';

function freshStore() {
  return new InMemoryIdempotencyStore();
}

describe("webhookReceiver (tRPC)", () => {
  it("calls next with idempotency injected on the happy path", async () => {
    const store = freshStore();
    const next = vi.fn(async () => ({ status: "processed" }));
    const middleware = webhookReceiver({ store });
    const result = await middleware({
      ctx: {
        headers: { "idempotency-key": "req-1" },
        rawBody: BODY,
      },
      next,
    });
    expect(next).toHaveBeenCalledWith({
      ctx: {
        headers: { "idempotency-key": "req-1" },
        rawBody: BODY,
        idempotency: { key: "req-1", deduped: false },
      },
    });
    expect(result).toEqual({ status: "processed" });
  });

  it("injects deduped: true on a re-claim", async () => {
    const store = freshStore();
    const next = vi.fn(async () => ({ status: "ok" }));
    const middleware = webhookReceiver({ store });
    const headers = { "idempotency-key": "req-1" };
    await middleware({ ctx: { headers, rawBody: BODY }, next });
    next.mockClear();
    await middleware({ ctx: { headers, rawBody: BODY }, next });
    const args = next.mock.calls[0] as unknown as [
      { ctx: { idempotency: { deduped: boolean } } },
    ];
    expect(args[0].ctx.idempotency.deduped).toBe(true);
  });

  it("throws TRPCError BAD_REQUEST on missing-key", async () => {
    const store = freshStore();
    const next = vi.fn();
    const middleware = webhookReceiver({ store });
    await expect(
      middleware({ ctx: { headers: {}, rawBody: BODY }, next })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "missing-key",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("throws TRPCError UNAUTHORIZED on verification failure", async () => {
    const store = freshStore();
    const next = vi.fn();
    const middleware = webhookReceiver({ store, secret: "test-secret" });
    // No signature headers — verification will fail with missing-signature.
    await expect(
      middleware({
        ctx: { headers: { "idempotency-key": "req-1" }, rawBody: BODY },
        next,
      })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "missing-signature",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("throws TRPCError instances (not plain Error)", async () => {
    const store = freshStore();
    const middleware = webhookReceiver({ store });
    try {
      await middleware({
        ctx: { headers: {}, rawBody: BODY },
        next: vi.fn(),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
    }
  });
});
