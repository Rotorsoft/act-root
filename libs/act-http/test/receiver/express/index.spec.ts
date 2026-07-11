import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { webhookMiddleware } from "../../../src/receiver/express/index.js";

const BODY = '{"orderId":"o-1"}';

function freshStore() {
  return new InMemoryIdempotencyStore();
}

/**
 * Minimal duck-typed Express request/response/next triplet. We don't
 * need a real Express app — the adapter only touches `req.headers`,
 * `req.body`, `res.status().json()`, and `next()`.
 */
function mockTriplet(headers: Record<string, unknown>, body: unknown) {
  const req = { headers, body } as unknown as Request;
  const json = vi.fn();
  const res = {
    status: vi.fn(function (this: { json: typeof json }) {
      return this as unknown as Response;
    }),
    json,
  } as unknown as Response & { json: typeof json };
  (
    res.status as unknown as { mockImplementation: typeof vi.fn }
  ).mockImplementation(function (this: Response) {
    return res;
  });
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, json };
}

describe("webhookMiddleware (Express)", () => {
  it("attaches req.idempotency and calls next() on the happy path", async () => {
    const store = freshStore();
    const { req, res, next } = mockTriplet(
      { "idempotency-key": "req-1" },
      BODY
    );
    const middleware = webhookMiddleware({ store });
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    const idem = (
      req as Request & {
        idempotency: {
          key: string;
          deduped: boolean;
          commit: () => unknown;
          release: () => unknown;
        };
      }
    ).idempotency;
    expect(idem.key).toBe("req-1");
    expect(idem.deduped).toBe(false);
    expect(typeof idem.commit).toBe("function");
    expect(typeof idem.release).toBe("function");
  });

  it("commit() durably dedups; a retry after success skips re-processing", async () => {
    const store = freshStore();
    const middleware = webhookMiddleware({ store });
    const { req, res, next } = mockTriplet(
      { "idempotency-key": "req-commit" },
      BODY
    );
    await middleware(req, res, next);
    await (
      req as Request & { idempotency: { commit: () => Promise<void> } }
    ).idempotency.commit();
    // Retry after a committed success — deduped.
    const second = mockTriplet({ "idempotency-key": "req-commit" }, BODY);
    await middleware(second.req, second.res, second.next);
    expect(
      (second.req as Request & { idempotency: { deduped: boolean } })
        .idempotency.deduped
    ).toBe(true);
  });

  it("release() frees the tentative claim; a retry after failure re-processes", async () => {
    const store = freshStore();
    const middleware = webhookMiddleware({ store });
    const { req, res, next } = mockTriplet(
      { "idempotency-key": "req-release" },
      BODY
    );
    await middleware(req, res, next);
    await (
      req as Request & { idempotency: { release: () => Promise<void> } }
    ).idempotency.release();
    // Retry after a released failure — the key is fresh again.
    const second = mockTriplet({ "idempotency-key": "req-release" }, BODY);
    await middleware(second.req, second.res, second.next);
    expect(
      (second.req as Request & { idempotency: { deduped: boolean } })
        .idempotency.deduped
    ).toBe(false);
  });

  it("accepts a Buffer body (express.raw output)", async () => {
    const store = freshStore();
    const { req, res, next } = mockTriplet(
      { "idempotency-key": "req-1" },
      Buffer.from(BODY)
    );
    const middleware = webhookMiddleware({ store });
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("handles a missing body gracefully when unsigned", async () => {
    const store = freshStore();
    const { req, res, next } = mockTriplet(
      { "idempotency-key": "req-1" },
      undefined
    );
    const middleware = webhookMiddleware({ store });
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("responds 400 missing-key without calling next()", async () => {
    const store = freshStore();
    const { req, res, next, json } = mockTriplet({}, BODY);
    const middleware = webhookMiddleware({ store });
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "missing-key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 with the verify failure reason", async () => {
    const store = freshStore();
    const { req, res, next, json } = mockTriplet(
      { "idempotency-key": "req-1" },
      BODY
    );
    const middleware = webhookMiddleware({ store, secret: "test-secret" });
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "missing-signature" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns deduped: true on a re-claim", async () => {
    const store = freshStore();
    const middleware = webhookMiddleware({ store });
    {
      const { req, res, next } = mockTriplet(
        { "idempotency-key": "req-1" },
        BODY
      );
      await middleware(req, res, next);
    }
    const second = mockTriplet({ "idempotency-key": "req-1" }, BODY);
    await middleware(second.req, second.res, second.next);
    expect(second.next).toHaveBeenCalled();
    expect(
      (
        second.req as Request & {
          idempotency: { deduped: boolean };
        }
      ).idempotency.deduped
    ).toBe(true);
  });
});
