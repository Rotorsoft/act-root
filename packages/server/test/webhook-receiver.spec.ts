import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebhookReceiver } from "../src/webhook-receiver.js";

// Choose a high port to avoid stomping local dev servers; tests run
// against the receiver via fetch end-to-end.
const PORT = 14_001;
const BASE = `http://127.0.0.1:${PORT}`;

let receiver: { close: () => Promise<void> };

beforeAll(() => {
  receiver = startWebhookReceiver(PORT);
});

afterAll(async () => {
  await receiver.close();
});

/**
 * tRPC-over-HTTP call. The standalone adapter accepts both GET and POST,
 * but mutations come over POST with the input JSON-encoded in the body.
 */
async function post(
  procedure: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : undefined,
  };
}

describe("webhook-receiver", () => {
  it("returns 'processed' on first delivery", async () => {
    const key = `it-process-${Date.now()}`;
    const res = await post(
      "escalations",
      { ticket: "t-1", escalationId: "e-1" },
      { "Idempotency-Key": key }
    );
    expect(res.status).toBe(200);
    expect(res.body.result.data.status).toBe("processed");
    expect(res.body.result.data.key).toBe(key);
    expect(res.body.result.data.ticket).toBe("t-1");
  });

  it("returns 'dedup-skipped' on a re-send with the same key", async () => {
    const key = `it-dedup-${Date.now()}`;
    const first = await post(
      "escalations",
      { ticket: "t-2", escalationId: "e-2" },
      { "Idempotency-Key": key }
    );
    expect(first.body.result.data.status).toBe("processed");

    const second = await post(
      "escalations",
      { ticket: "t-2", escalationId: "e-2" },
      { "Idempotency-Key": key }
    );
    expect(second.status).toBe(200);
    expect(second.body.result.data.status).toBe("dedup-skipped");
    expect(second.body.result.data.key).toBe(key);
  });

  it("rejects requests without Idempotency-Key", async () => {
    const res = await post("escalations", {
      ticket: "t-3",
      escalationId: "e-3",
    });
    // tRPC error responses come back as 400 with an `error` envelope.
    // The middleware's structured `reason` codes flow through as the
    // error message — `missing-key` rather than a human-readable string.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.message).toBe("missing-key");
  });

  it("returns case-insensitive on the Idempotency-Key header", async () => {
    const key = `it-case-${Date.now()}`;
    const first = await post(
      "escalations",
      { ticket: "t-4", escalationId: "e-4" },
      { "idempotency-key": key } // lowercase header
    );
    expect(first.body.result.data.status).toBe("processed");

    const second = await post(
      "escalations",
      { ticket: "t-4", escalationId: "e-4" },
      { "IDEMPOTENCY-KEY": key } // uppercase header
    );
    expect(second.body.result.data.status).toBe("dedup-skipped");
  });
});
