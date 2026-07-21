import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { receiver } from "../../src/receiver/start.js";
import { sign_request } from "../../src/webhook/sign.js";

/**
 * Wrap an idempotency store to record how many times each key is
 * committed/released — the route and the mounted `webhookMiddleware`
 * must together finalize a delivery exactly once (#1293).
 */
function countingStore(inner: IdempotencyStore): {
  store: IdempotencyStore;
  commits: string[];
  releases: string[];
} {
  const commits: string[] = [];
  const releases: string[] = [];
  const store: IdempotencyStore = {
    claim: (k) => inner.claim(k),
    commit: (k) => {
      commits.push(k);
      return inner.commit(k);
    },
    release: (k) => {
      releases.push(k);
      return inner.release(k);
    },
  };
  return { store, commits, releases };
}

const OrderSchema = z.object({
  orderId: z.string(),
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
    let called: { orderId: string; total: number; key: string } | undefined;

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
        body: JSON.stringify({ orderId: "o-1", total: 99.5 }),
      })
    );

    expect(response.status).toBe(204);
    expect(called).toEqual({ orderId: "o-1", total: 99.5, key: "req-1" });
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
          body: JSON.stringify({ orderId: "o-1", total: 1 }),
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
        body: JSON.stringify({ orderId: "o-1", total: 1 }),
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
        body: JSON.stringify({ orderId: "o-1" }), // missing `total`
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
        body: JSON.stringify({ orderId: "o-1", total: 1 }),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing-signature" });
  });

  it("accepts signed requests when secret is configured", async () => {
    const SECRET = "shared";
    const body = JSON.stringify({ orderId: "o-7", total: 42 });
    const { signature, timestamp } = sign_request(body, SECRET);

    let called = false;
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
      secret: SECRET,
    })
      .on("OrderConfirmed", OrderSchema, async (event) => {
        expect(event.orderId).toBe("o-7");
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
        body: JSON.stringify({ orderId: "o-1", total: 1 }),
      })
    );

    expect(response.status).toBe(500);
    const responseBody = (await response.json()) as {
      error: string;
      detail: string;
    };
    expect(responseBody.error).toBe("handler-failed");
    expect(responseBody.detail).toContain("downstream service unreachable");
  });

  it("re-runs the handler on retry after a transient handler failure (no lost delivery)", async () => {
    let attempts = 0;
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient downstream outage");
      })
      .build();

    const fire = () =>
      r.fetch(
        new Request("http://localhost/OrderConfirmed", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "req-transient",
          },
          body: JSON.stringify({ orderId: "o-1", total: 1 }),
        })
      );

    // First delivery fails transiently — 500, key must NOT be committed.
    const first = await fire();
    expect(first.status).toBe(500);

    // Sender retries with the same key — the handler must run again
    // (the fix), not be short-circuited into a silent 204 (the bug).
    const second = await fire();
    expect(second.status).toBe(204);
    expect(attempts).toBe(2);
  });

  it("finalizes a successful delivery exactly once — no double commit (#1293)", async () => {
    const { store, commits, releases } = countingStore(
      new InMemoryIdempotencyStore()
    );
    const r = receiver({ port: 0, store })
      .on("OrderConfirmed", OrderSchema, async () => {})
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "req-once-ok",
        },
        body: JSON.stringify({ orderId: "o-1", total: 1 }),
      })
    );

    // The route's finalize and the middleware's auto-finalize collapse
    // into a single store call via the `settled` guard.
    expect(response.status).toBe(204);
    expect(commits).toEqual(["req-once-ok"]);
    expect(releases).toEqual([]);
  });

  it("finalizes a failed delivery exactly once — no double release (#1293)", async () => {
    const { store, commits, releases } = countingStore(
      new InMemoryIdempotencyStore()
    );
    const r = receiver({ port: 0, store })
      .on("OrderConfirmed", OrderSchema, async () => {
        throw new Error("downstream unreachable");
      })
      .build();

    const response = await r.fetch(
      new Request("http://localhost/OrderConfirmed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "req-once-fail",
        },
        body: JSON.stringify({ orderId: "o-1", total: 1 }),
      })
    );

    // A second, stale release would delete a concurrent retry's live claim.
    expect(response.status).toBe(500);
    expect(releases).toEqual(["req-once-fail"]);
    expect(commits).toEqual([]);
  });

  it("dedups a retry after a successful delivery (handler runs exactly once)", async () => {
    let attempts = 0;
    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {
        attempts++;
      })
      .build();

    const fire = () =>
      r.fetch(
        new Request("http://localhost/OrderConfirmed", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "req-committed",
          },
          body: JSON.stringify({ orderId: "o-1", total: 1 }),
        })
      );

    expect((await fire()).status).toBe(204);
    // Retry after success — deduped, handler does not run again.
    expect((await fire()).status).toBe(204);
    expect(attempts).toBe(1);
  });

  it("dedups a concurrent duplicate that arrives while the handler is in flight", async () => {
    let attempts = 0;
    let release_handler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release_handler = resolve;
    });

    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async () => {
        attempts++;
        await gate;
      })
      .build();

    const fire = () =>
      r.fetch(
        new Request("http://localhost/OrderConfirmed", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "req-concurrent",
          },
          body: JSON.stringify({ orderId: "o-1", total: 1 }),
        })
      );

    // Fire the first delivery; its handler blocks on the gate.
    const first = fire();
    // A concurrent duplicate arrives mid-flight — the tentative claim
    // must dedup it so the handler is not entered twice.
    const second = await fire();
    expect(second.status).toBe(204);

    release_handler?.();
    expect((await first).status).toBe(204);
    expect(attempts).toBe(1);
  });

  it("supports chaining multiple .on() calls with independent handler types", async () => {
    const ShipmentSchema = z.object({ trackingId: z.string() });
    let order: { orderId: string } | undefined;
    let shipment: { trackingId: string } | undefined;

    const r = receiver({
      port: 0,
      store: new InMemoryIdempotencyStore(),
    })
      .on("OrderConfirmed", OrderSchema, async (event) => {
        order = { orderId: event.orderId };
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
        body: JSON.stringify({ orderId: "o-1", total: 1 }),
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

    expect(order).toEqual({ orderId: "o-1" });
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
      body: JSON.stringify({ orderId: "o-live", total: 1 }),
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
