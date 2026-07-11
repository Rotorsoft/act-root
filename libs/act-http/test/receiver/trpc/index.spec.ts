import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { webhookMiddleware } from "../../../src/receiver/trpc/index.js";

const BODY = '{"orderId":"o-1"}';

function freshStore() {
  return new InMemoryIdempotencyStore();
}

describe("webhookMiddleware (tRPC)", () => {
  it("calls next with idempotency injected on the happy path", async () => {
    const store = freshStore();
    const next = vi.fn(async () => ({ status: "processed" }));
    const middleware = webhookMiddleware({ store });
    const result = await middleware({
      ctx: {
        headers: { "idempotency-key": "req-1" },
        rawBody: BODY,
      },
      next,
    });
    const call = next.mock.calls[0] as unknown as [
      {
        ctx: {
          headers: unknown;
          rawBody: unknown;
          idempotency: {
            key: string;
            deduped: boolean;
            commit: () => unknown;
            release: () => unknown;
          };
        };
      },
    ];
    expect(call[0].ctx.headers).toEqual({ "idempotency-key": "req-1" });
    expect(call[0].ctx.rawBody).toBe(BODY);
    expect(call[0].ctx.idempotency.key).toBe("req-1");
    expect(call[0].ctx.idempotency.deduped).toBe(false);
    expect(typeof call[0].ctx.idempotency.commit).toBe("function");
    expect(typeof call[0].ctx.idempotency.release).toBe("function");
    expect(result).toEqual({ status: "processed" });
  });

  it("commits on a resolved resolver — a retry after success dedups", async () => {
    const store = freshStore();
    const headers = { "idempotency-key": "req-commit" };
    const okNext = vi.fn(async () => ({ ok: true, data: 1 }));
    const middleware = webhookMiddleware({ store });
    await middleware({ ctx: { headers, rawBody: BODY }, next: okNext });
    // Retry after success — deduped, downstream not entered again.
    const retryNext = vi.fn(async () => ({ ok: true }));
    await middleware({ ctx: { headers, rawBody: BODY }, next: retryNext });
    const args = retryNext.mock.calls[0] as unknown as [
      { ctx: { idempotency: { deduped: boolean } } },
    ];
    expect(args[0].ctx.idempotency.deduped).toBe(true);
  });

  it("releases when the resolver throws — a retry after failure re-processes", async () => {
    const store = freshStore();
    const headers = { "idempotency-key": "req-throw" };
    const boom = vi.fn(async () => {
      throw new Error("transient outage");
    });
    const middleware = webhookMiddleware({ store });
    await expect(
      middleware({ ctx: { headers, rawBody: BODY }, next: boom })
    ).rejects.toThrow("transient outage");
    // Retry after the release — the key is fresh again.
    const retryNext = vi.fn(async () => ({ ok: true }));
    await middleware({ ctx: { headers, rawBody: BODY }, next: retryNext });
    const args = retryNext.mock.calls[0] as unknown as [
      { ctx: { idempotency: { deduped: boolean } } },
    ];
    expect(args[0].ctx.idempotency.deduped).toBe(false);
  });

  it("releases when the resolver returns { ok: false } — a retry re-processes", async () => {
    const store = freshStore();
    const headers = { "idempotency-key": "req-not-ok" };
    const notOk = vi.fn(async () => ({ ok: false }));
    const middleware = webhookMiddleware({ store });
    await middleware({ ctx: { headers, rawBody: BODY }, next: notOk });
    const retryNext = vi.fn(async () => ({ ok: true }));
    await middleware({ ctx: { headers, rawBody: BODY }, next: retryNext });
    const args = retryNext.mock.calls[0] as unknown as [
      { ctx: { idempotency: { deduped: boolean } } },
    ];
    expect(args[0].ctx.idempotency.deduped).toBe(false);
  });

  it("injects deduped: true on a re-claim", async () => {
    const store = freshStore();
    const next = vi.fn(async () => ({ status: "ok" }));
    const middleware = webhookMiddleware({ store });
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
    const middleware = webhookMiddleware({ store });
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
    const middleware = webhookMiddleware({ store, secret: "test-secret" });
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
    const middleware = webhookMiddleware({ store });
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
