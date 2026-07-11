import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { webhookMiddleware } from "../../../src/receiver/fastify/index.js";

const BODY = '{"orderId":"o-1"}';

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
    const idem = (
      req as FastifyRequest & {
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
    const req = mockRequest({ "idempotency-key": "req-commit" }, BODY);
    const { reply } = mockReply();
    await middleware(req, reply);
    await (
      req as FastifyRequest & { idempotency: { commit: () => Promise<void> } }
    ).idempotency.commit();
    const req2 = mockRequest({ "idempotency-key": "req-commit" }, BODY);
    const { reply: reply2 } = mockReply();
    await middleware(req2, reply2);
    expect(
      (req2 as FastifyRequest & { idempotency: { deduped: boolean } })
        .idempotency.deduped
    ).toBe(true);
  });

  it("release() frees the tentative claim; a retry after failure re-processes", async () => {
    const store = freshStore();
    const middleware = webhookMiddleware({ store });
    const req = mockRequest({ "idempotency-key": "req-release" }, BODY);
    const { reply } = mockReply();
    await middleware(req, reply);
    await (
      req as FastifyRequest & { idempotency: { release: () => Promise<void> } }
    ).idempotency.release();
    const req2 = mockRequest({ "idempotency-key": "req-release" }, BODY);
    const { reply: reply2 } = mockReply();
    await middleware(req2, reply2);
    expect(
      (req2 as FastifyRequest & { idempotency: { deduped: boolean } })
        .idempotency.deduped
    ).toBe(false);
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

  it("replies 400 empty-body when secret is set but rawBody was not captured", async () => {
    const store = freshStore();
    // secret set + no rawBody (default JSON parser ate the bytes) →
    // don't hash an empty body and 401 with a misleading bad-signature.
    // Surface the distinct configuration error instead.
    const req = mockRequest(
      { "idempotency-key": "req-1", "x-webhook-signature": "sha256=deadbeef" },
      undefined
    );
    const { reply, send } = mockReply();
    const middleware = webhookMiddleware({ store, secret: "test-secret" });
    await middleware(req, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({ error: "empty-body" });
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
