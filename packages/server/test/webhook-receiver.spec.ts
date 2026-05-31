import { receiver } from "@rotorsoft/act-http/receiver";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

// Choose a high port to avoid stomping local dev servers; tests run
// against the receiver via fetch end-to-end.
const PORT = 14_001;
const BASE = `http://127.0.0.1:${PORT}`;

const EscalationPayload = z.object({
  ticket: z.string(),
  escalationId: z.string(),
});

const escalations = receiver({
  port: PORT,
  store: new InMemoryIdempotencyStore({
    ttlMs: 24 * 60 * 60 * 1000,
    maxEntries: 50_000,
  }),
})
  .on("escalations", EscalationPayload, async () => {
    // Demo handler — the tests only need the HTTP envelope.
  })
  .build();

beforeAll(async () => {
  await escalations.listen();
});

afterAll(async () => {
  await escalations.close();
});

/**
 * POST to a named webhook event. The high-level adapter mounts each
 * registered handler at `/<eventName>` and returns plain HTTP
 * responses (204 on success / 400 / 401 / 422 on failure).
 */
async function post(
  eventName: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/${eventName}`, {
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
  it("returns 204 on first delivery", async () => {
    const key = `it-process-${Date.now()}`;
    const res = await post(
      "escalations",
      { ticket: "t-1", escalationId: "e-1" },
      { "Idempotency-Key": key }
    );
    expect(res.status).toBe(204);
  });

  it("returns 204 on a re-send with the same key (dedup-skipped silently)", async () => {
    const key = `it-dedup-${Date.now()}`;
    const first = await post(
      "escalations",
      { ticket: "t-2", escalationId: "e-2" },
      { "Idempotency-Key": key }
    );
    expect(first.status).toBe(204);

    const second = await post(
      "escalations",
      { ticket: "t-2", escalationId: "e-2" },
      { "Idempotency-Key": key }
    );
    // Dedup-hit returns the same 204 — the sender treats both as
    // "accepted, stop retrying." The receiver's logs distinguish them.
    expect(second.status).toBe(204);
  });

  it("rejects requests without Idempotency-Key with 400 missing-key", async () => {
    const res = await post("escalations", {
      ticket: "t-3",
      escalationId: "e-3",
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing-key" });
  });

  it("accepts case-insensitive Idempotency-Key header", async () => {
    const key = `it-case-${Date.now()}`;
    const first = await post(
      "escalations",
      { ticket: "t-4", escalationId: "e-4" },
      { "idempotency-key": key } // lowercase header
    );
    expect(first.status).toBe(204);

    const second = await post(
      "escalations",
      { ticket: "t-4", escalationId: "e-4" },
      { "IDEMPOTENCY-KEY": key } // uppercase header
    );
    expect(second.status).toBe(204); // dedup-skipped
  });

  it("rejects payloads that don't match the schema with 422 validation-failed", async () => {
    const res = await post(
      "escalations",
      { ticket: "t-5" }, // missing escalationId
      { "Idempotency-Key": `it-schema-${Date.now()}` }
    );
    expect(res.status).toBe(422);
    const body = res.body as { error: string };
    expect(body.error).toBe("validation-failed");
  });
});
