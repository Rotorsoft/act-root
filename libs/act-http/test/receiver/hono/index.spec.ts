import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { webhookReceiver } from "../../../src/receiver/hono/index.js";

const BODY = '{"orderId":"o-1"}';

function freshStore() {
  return new InMemoryIdempotencyStore();
}

describe("webhookReceiver (Hono)", () => {
  it("attaches idempotency on the happy path and continues", async () => {
    const store = freshStore();
    const app = new Hono();
    app.post("/webhook", webhookReceiver({ store }), (c) => {
      const idem = c.get("idempotency");
      return c.json(idem);
    });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "idempotency-key": "req-1" },
      body: BODY,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "req-1", deduped: false });
  });

  it("returns 400 missing-key", async () => {
    const store = freshStore();
    const app = new Hono();
    app.post("/webhook", webhookReceiver({ store }), (c) => c.text("ok"));

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
      webhookReceiver({ store, secret: "test-secret" }),
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
    app.post("/webhook", webhookReceiver({ store }), (c) =>
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
