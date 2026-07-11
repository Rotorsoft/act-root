import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { webhookMiddleware } from "../../../src/receiver/hono/index.js";

const BODY = '{"orderId":"o-1"}';

function freshStore() {
  return new InMemoryIdempotencyStore();
}

describe("webhookMiddleware (Hono)", () => {
  it("attaches idempotency on the happy path and continues", async () => {
    const store = freshStore();
    const app = new Hono();
    app.post("/webhook", webhookMiddleware({ store }), (c) => {
      const idem = c.get("idempotency");
      return c.json({ key: idem.key, deduped: idem.deduped });
    });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "idempotency-key": "req-1" },
      body: BODY,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "req-1", deduped: false });
  });

  it("auto-commits on a 2xx response — a retry after success is marked deduped", async () => {
    const store = freshStore();
    let sideEffects = 0;
    const app = new Hono();
    app.post("/webhook", webhookMiddleware({ store }), (c) => {
      const idem = c.get("idempotency");
      if (!idem.deduped) sideEffects++;
      return c.body(null, 204);
    });

    const fire = () =>
      app.request("/webhook", {
        method: "POST",
        headers: { "idempotency-key": "req-ok" },
        body: BODY,
      });

    expect((await fire()).status).toBe(204);
    // Retry after success — the auto-commit means the claim is durable,
    // so the second delivery is deduped and skips its side effect.
    const second = await fire();
    expect(second.status).toBe(204);
    expect(sideEffects).toBe(1);
  });

  it("auto-releases on a 5xx response — a retry after failure re-processes", async () => {
    const store = freshStore();
    let sideEffects = 0;
    let hits = 0;
    const app = new Hono();
    app.post("/webhook", webhookMiddleware({ store }), (c) => {
      const idem = c.get("idempotency");
      hits++;
      if (!idem.deduped) sideEffects++;
      if (hits === 1) return c.json({ error: "boom" }, 500);
      return c.body(null, 204);
    });

    const fire = () =>
      app.request("/webhook", {
        method: "POST",
        headers: { "idempotency-key": "req-5xx" },
        body: BODY,
      });

    expect((await fire()).status).toBe(500);
    // Retry after the transient 5xx — the released claim is fresh again,
    // so the handler runs its side effect a second time (not lost).
    const second = await fire();
    expect(second.status).toBe(204);
    expect(sideEffects).toBe(2);
  });

  it("releases and re-throws when next() rejects (downstream error propagates)", async () => {
    const store = freshStore();
    const middleware = webhookMiddleware({ store });

    // Drive the middleware directly with a minimal Hono-shaped context so
    // the downstream error propagates out of next() instead of being
    // absorbed by Hono's app-level default error handler. This exercises
    // the middleware's catch: release the tentative claim, then re-throw.
    const makeCtx = () => {
      const vars: Record<string, unknown> = {};
      return {
        req: {
          raw: { headers: new Headers({ "idempotency-key": "req-reject" }) },
          text: async () => BODY,
        },
        res: { status: 200 },
        set: (k: string, v: unknown) => {
          vars[k] = v;
        },
        get: (k: string) => vars[k],
        json: (body: unknown, status: number) => ({ body, status }),
      } as never;
    };

    const boom = async () => {
      throw new Error("propagated outage");
    };
    await expect(middleware(makeCtx(), boom)).rejects.toThrow(
      "propagated outage"
    );
    // The claim was released — a fresh claim on the same key succeeds.
    expect(store.claim("req-reject")).toBe(true);
  });

  it("auto-releases when a downstream handler throws — a retry re-processes", async () => {
    const store = freshStore();
    let sideEffects = 0;
    let hits = 0;
    const app = new Hono();
    app.onError((_err, c) => c.json({ error: "unhandled" }, 500));
    app.post("/webhook", webhookMiddleware({ store }), (c) => {
      const idem = c.get("idempotency");
      hits++;
      if (!idem.deduped) sideEffects++;
      if (hits === 1) throw new Error("thrown outage");
      return c.body(null, 204);
    });

    const fire = () =>
      app.request("/webhook", {
        method: "POST",
        headers: { "idempotency-key": "req-throw" },
        body: BODY,
      });

    expect((await fire()).status).toBe(500);
    const second = await fire();
    expect(second.status).toBe(204);
    expect(sideEffects).toBe(2);
  });

  it("returns 400 missing-key", async () => {
    const store = freshStore();
    const app = new Hono();
    app.post("/webhook", webhookMiddleware({ store }), (c) => c.text("ok"));

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {},
      body: BODY,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing-key" });
  });

  it("returns 401 on verify failure", async () => {
    const store = freshStore();
    const app = new Hono();
    app.post(
      "/webhook",
      webhookMiddleware({ store, secret: "test-secret" }),
      (c) => c.text("ok")
    );

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "idempotency-key": "req-1" },
      body: BODY,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing-signature" });
  });

  it("returns deduped: true on a re-claim", async () => {
    const store = freshStore();
    const app = new Hono();
    app.post("/webhook", webhookMiddleware({ store }), (c) =>
      c.json(c.get("idempotency"))
    );

    await app.request("/webhook", {
      method: "POST",
      headers: { "idempotency-key": "req-1" },
      body: BODY,
    });
    const second = await app.request("/webhook", {
      method: "POST",
      headers: { "idempotency-key": "req-1" },
      body: BODY,
    });
    expect(await second.json()).toEqual({ key: "req-1", deduped: true });
  });
});
