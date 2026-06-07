import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { webhookMiddleware } from "../../../src/receiver/express/index.js";

const BODY = '{"order_id":"o-1"}';

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
    expect((req as Request & { idempotency: unknown }).idempotency).toEqual({
      key: "req-1",
      deduped: false,
    });
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
