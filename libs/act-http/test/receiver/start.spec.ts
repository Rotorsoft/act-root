import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { receiver } from "../../src/receiver/start.js";
import { sign_request } from "../../src/webhook/sign.js";

const OrderSchema = z.object({
  order_id: z.string(),
  total: z.number(),
});

let receiverRef: { close: () => Promise<void> } | undefined;

afterEach(async () => {
  if (receiverRef) {
    await receiverRef.close();
    receiverRef = undefined;
  }
});

describe("receiver — fetch mode (Lambda / edge / serverless)", () => {
  it("routes POST /<event_name> to the registered handler with a typed event", async () => {
    let called: { order_id: string; total: number; key: string } | undefined;

    const r = receiver({
      port: 0, // not used in fetch mode
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async (event, ctx) => {
        called = { ...event, key: ctx.key };
      })
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "req-1",
        },
        body: JSON.stringify({ order_id: "o-1", total: 99.5 }),
      })
    );

    expect(response.status).toBe(204);
    expect(called).toEqual({ order_id: "o-1", total: 99.5, key: "req-1" });
  });

  it("returns 204 without calling the handler on a deduplicated re-send", async () => {
    let callCount = 0;
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {
        callCount++;
      })
      .build();

    const fire = () =>
      r.fetch(
        new Request("http://localhost/OrderConfirmed", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "req-dup",
          },
          body: JSON.stringify({ order_id: "o-1", total: 1 }),
        })
      );

    expect((await fire()).status).toBe(204);
    expect((await fire()).status).toBe(204);
    expect(callCount).toBe(1);
  });

  it("returns 400 missing-key on requests without Idempotency-Key", async () => {
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {})
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_id: "o-1", total: 1 }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing-key" });
  });

  it("returns 422 validation-failed when the body doesn't match the schema", async () => {
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {})
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "req-bad",
        },
        body: JSON.stringify({ order_id: "o-1" }), // missing `total`
      })
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("validation-failed");
  });

  it("returns 401 with the verify reason when signature is missing/bad", async () => {
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
      secret: "test-secret",
    })
      .on("OrderConfirmed", OrderSchema, async () => {})
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "req-1",
        },
        body: JSON.stringify({ order_id: "o-1", total: 1 }),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing-signature" });
  });

  it("accepts signed requests when secret is configured", async () => {
    const SECRET = "shared";
    const body = JSON.stringify({ order_id: "o-7", total: 42 });
    const { signature, timestamp } = sign_request(body, SECRET);

    let called = false;
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
      secret: SECRET,
    })
      .on("OrderConfirmed", OrderSchema, async (event) => {
        expect(event.order_id).toBe("o-7");
        called = true;
      })
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "req-signed",
          "x-webhook-signature": signature,
          "x-webhook-timestamp": timestamp,
        },
        body,
      })
    );

    expect(response.status).toBe(204);
    expect(called).toBe(true);
  });

  it("returns 500 handler-failed when the handler throws", async () => {
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {
        throw new Error("downstream service unreachable");
      })
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "req-fail",
        },
        body: JSON.stringify({ order_id: "o-1", total: 1 }),
      })
    );

    expect(response.status).toBe(500);
    const response_body = (await response.json()) as {
      error: string;
      detail: string;
    };
    expect(response_body.error).toBe("handler-failed");
    expect(response_body.detail).toContain("downstream service unreachable");
  });

  it("supports chaining multiple .on() calls with independent handler types", async () => {
    const ShipmentSchema = z.object({ trackingId: z.string() });
    let order: { order_id: string } | undefined;
    let shipment: { trackingId: string } | undefined;

    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async (event) => {
        order = { order_id: event.order_id };
      })
      .on("OrderShipped", ShipmentSchema, async (event) => {
        shipment = { trackingId: event.trackingId };
      })
      .build();

    await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "k1",
        },
        body: JSON.stringify({ order_id: "o-1", total: 1 }),
      })
    );

    await r.fetch(
      new Request("http://localhost/OrderShipped", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "k2",
        },
        body: JSON.stringify({ trackingId: "trk-1" }),
      })
    );

    expect(order).toEqual({ order_id: "o-1" });
    expect(shipment).toEqual({ trackingId: "trk-1" });
  });
});

describe("receiver — listen mode (long-running Node server)", () => {
  it("binds to a port, accepts a request, and closes cleanly", async () => {
    let called = false;
    const r = receiver({
      port: 14_002,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {
        called = true;
      })
      .build();
    receiverRef = r;

    await r.listen();
    const response = await fetch("http://127.0.0.1:14002/OrderConfirmed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "live-1",
      },
      body: JSON.stringify({ order_id: "o-live", total: 1 }),
    });
    expect(response.status).toBe(204);
    expect(called).toBe(true);
  });

  it("throws when .on() is called after .build() (builder is frozen)", () => {
    const builder = receiver({
      port: 14_003,
      store: new InMemoryIdempotencyStore(),
    });
    builder.build();
    expect(() => builder.on("Late", OrderSchema, async () => {})).toThrow(
      /Cannot register handler/
    );
  });

  it("close() is a no-op when called before listen()", async () => {
    const r = receiver({
      port: 14_004,
      store: new InMemoryIdempotencyStore(),
    }).build();
    await expect(r.close()).resolves.toBeUndefined();
  });
});
