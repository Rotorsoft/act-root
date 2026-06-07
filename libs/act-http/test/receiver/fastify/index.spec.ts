import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { webhookMiddleware } from "../../../src/receiver/fastify/index.js";

const BODY = '{"order_id":"o-1"}';

function freshStore() {
  return new InMemoryIdempotencyStore();
}

function mockReply() {
  const send = vi.fn(async () => undefined);
  const reply = {
    status: vi.fn(function (this: { send: typeof send }) {
      return this as unknown as FastifyReply;
    }),
    send,
  } as unknown as FastifyReply & { send: typeof send };
  return { reply, send };
}

function mockRequest(headers: Record<string, unknown>, rawBody?: string) {
  return {
    headers,
    rawBody,
  } as unknown as FastifyRequest;
}

describe("webhookMiddleware (Fastify)", () => {
  it("attaches request.idempotency on the happy path", async () => {
    const store = freshStore();
    const req = mockRequest({ "idempotency-key": "req-1" }, BODY);
    const { reply } = mockReply();
    const middleware = webhookMiddleware({ store });
    await middleware(req, reply);
    expect(
      (req as FastifyRequest & { idempotency: unknown }).idempotency
    ).toEqual({ key: "req-1", deduped: false });
  });

  it("replies 400 on missing-key", async () => {
    const store = freshStore();
    const req = mockRequest({}, BODY);
    const { reply, send } = mockReply();
    const middleware = webhookMiddleware({ store });
    await middleware(req, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({ error: "missing-key" });
  });

  it("replies 401 on verify failure", async () => {
    const store = freshStore();
    const req = mockRequest({ "idempotency-key": "req-1" }, BODY);
    const { reply, send } = mockReply();
    const middleware = webhookMiddleware({ store, secret: "test-secret" });
    await middleware(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({ error: "missing-signature" });
  });

  it("handles a missing rawBody (unsigned mode)", async () => {
    const store = freshStore();
    const req = mockRequest({ "idempotency-key": "req-1" });
    const { reply } = mockReply();
    const middleware = webhookMiddleware({ store });
    await middleware(req, reply);
    expect(
      (req as FastifyRequest & { idempotency: unknown }).idempotency
    ).toBeDefined();
  });

  it("returns deduped: true on a re-claim", async () => {
    const store = freshStore();
    const middleware = webhookMiddleware({ store });
    {
      const req = mockRequest({ "idempotency-key": "req-1" }, BODY);
      const { reply } = mockReply();
      await middleware(req, reply);
    }
    const req2 = mockRequest({ "idempotency-key": "req-1" }, BODY);
    const { reply: reply2 } = mockReply();
    await middleware(req2, reply2);
    expect(
      (req2 as FastifyRequest & { idempotency: { deduped: boolean } })
        .idempotency.deduped
    ).toBe(true);
  });
});
