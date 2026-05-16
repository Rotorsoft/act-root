import { type Committed, NonRetryableError } from "@rotorsoft/act";
import { describe, expect, it, vi } from "vitest";
import {
  NonRetryableWebhookError,
  WebhookError,
  webhook,
} from "../../src/webhook/index.js";

type Events = {
  OrderConfirmed: { orderId: string; total: number };
};

function makeEvent(
  overrides: Partial<Committed<Events, "OrderConfirmed">> = {}
): Committed<Events, "OrderConfirmed"> {
  return {
    id: 42,
    name: "OrderConfirmed",
    stream: "order-7",
    version: 0,
    created: new Date("2026-05-16T10:00:00Z"),
    data: { orderId: "order-7", total: 99.5 },
    meta: { correlation: "test-corr", causation: {} },
    ...overrides,
  };
}

type FakeResponse = { status: number; body?: string };

/** Minimal mock fetch that records call shape and yields a programmed response. */
function makeFetch(response: FakeResponse | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (typeof response === "function") return response();
    return new Response(response.body ?? null, { status: response.status });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe("webhook", () => {
  describe("success path", () => {
    it("returns void on 2xx response", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      await expect(
        handler(makeEvent(), "stream-1", {} as never)
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it("defaults method to POST and Content-Type to application/json", async () => {
      const { fetch, calls } = makeFetch({ status: 204 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      const init = calls[0].init;
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json"
      );
    });
  });

  describe("retry classification", () => {
    it("throws WebhookError on 500", async () => {
      const { fetch } = makeFetch({ status: 500, body: "boom" });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      try {
        await handler(makeEvent(), "stream-1", {} as never);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookError);
        expect(err).not.toBeInstanceOf(NonRetryableError);
        const e = err as WebhookError;
        expect(e.status).toBe(500);
        expect(e.responseBody).toBe("boom");
      }
    });

    it("throws WebhookError on 503", async () => {
      const { fetch } = makeFetch({ status: 503 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      await expect(
        handler(makeEvent(), "stream-1", {} as never)
      ).rejects.toBeInstanceOf(WebhookError);
    });

    it("throws NonRetryableWebhookError on 400", async () => {
      const { fetch } = makeFetch({ status: 400, body: "bad input" });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      try {
        await handler(makeEvent(), "stream-1", {} as never);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(NonRetryableWebhookError);
        expect(err).toBeInstanceOf(NonRetryableError);
        const e = err as NonRetryableWebhookError;
        expect(e.status).toBe(400);
        expect(e.responseBody).toBe("bad input");
      }
    });

    it("throws NonRetryableWebhookError on 404", async () => {
      const { fetch } = makeFetch({ status: 404 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      await expect(
        handler(makeEvent(), "stream-1", {} as never)
      ).rejects.toBeInstanceOf(NonRetryableWebhookError);
    });
  });

  describe("network and timeout errors", () => {
    it("throws WebhookError with status 0 on network error", async () => {
      const fetch = vi.fn(async () => {
        throw new TypeError("network down");
      }) as unknown as typeof globalThis.fetch;
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      try {
        await handler(makeEvent(), "stream-1", {} as never);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookError);
        expect(err).not.toBeInstanceOf(NonRetryableError);
        const e = err as WebhookError;
        expect(e.status).toBe(0);
        expect(e.message).toContain("network down");
      }
    });

    it("aborts and throws WebhookError on timeout", async () => {
      const fetch = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          })
      ) as unknown as typeof globalThis.fetch;
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        timeoutMs: 10,
        fetch,
      });
      try {
        await handler(makeEvent(), "stream-1", {} as never);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookError);
        expect(err).not.toBeInstanceOf(NonRetryableError);
        const e = err as WebhookError;
        expect(e.status).toBe(0);
        expect(e.message).toContain("timed out after 10ms");
      }
    });
  });

  describe("idempotency key", () => {
    it("derives Idempotency-Key from event.id by default", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      await handler(makeEvent({ id: 1234 }), "stream-1", {} as never);
      expect(
        (calls[0].init.headers as Record<string, string>)["Idempotency-Key"]
      ).toBe("1234");
    });

    it("uses idempotencyKey override when provided", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        idempotencyKey: (e) => `${e.stream}-${e.id}`,
        fetch,
      });
      await handler(makeEvent({ id: 42 }), "stream-1", {} as never);
      expect(
        (calls[0].init.headers as Record<string, string>)["Idempotency-Key"]
      ).toBe("order-7-42");
    });

    it("skips Idempotency-Key when override returns null", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        idempotencyKey: () => null,
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBeUndefined();
    });

    it("respects caller-supplied Idempotency-Key in headers (case-insensitive)", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        headers: { "idempotency-key": "caller-supplied" },
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBe("caller-supplied");
      expect(headers["Idempotency-Key"]).toBeUndefined();
    });

    it("respects caller-supplied Content-Type (case-insensitive)", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        headers: { "content-type": "application/x-protobuf" },
        body: "raw-bytes",
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/x-protobuf");
      expect(headers["Content-Type"]).toBeUndefined();
    });
  });

  describe("header and body resolvers", () => {
    it("invokes header function with the event", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        headers: (e) => ({ "X-Stream": e.stream, Authorization: "Bearer x" }),
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["X-Stream"]).toBe("order-7");
      expect(headers.Authorization).toBe("Bearer x");
    });

    it("invokes body function with the event and JSON-serializes the result", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        body: (e: Committed<Events, keyof Events>) => ({
          kind: e.name,
          order: e.data.orderId,
          total: e.data.total,
        }),
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        kind: "OrderConfirmed",
        order: "order-7",
        total: 99.5,
      });
    });

    it("passes a string body through unmodified", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        body: "raw-payload",
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      expect(calls[0].init.body).toBe("raw-payload");
    });

    it("defaults body to the committed event", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        fetch,
      });
      const event = makeEvent();
      await handler(event, "stream-1", {} as never);
      const parsed = JSON.parse(calls[0].init.body as string);
      expect(parsed.name).toBe("OrderConfirmed");
      expect(parsed.data.orderId).toBe("order-7");
    });

    it("invokes url function with the event", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: (e) => `https://example.com/${e.stream}`,
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      expect(calls[0].url).toBe("https://example.com/order-7");
    });

    it("respects configured method", async () => {
      const { fetch, calls } = makeFetch({ status: 200 });
      const handler = webhook<Events>({
        url: "https://example.com/hook",
        method: "PUT",
        fetch,
      });
      await handler(makeEvent(), "stream-1", {} as never);
      expect(calls[0].init.method).toBe("PUT");
    });
  });

  describe("error classes", () => {
    it("WebhookError exposes url and status fields", () => {
      const err = new WebhookError("boom", {
        status: 502,
        url: "https://x.example",
      });
      expect(err.name).toBe("WebhookError");
      expect(err.status).toBe(502);
      expect(err.url).toBe("https://x.example");
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NonRetryableError);
    });

    it("NonRetryableWebhookError is a NonRetryableError", () => {
      const err = new NonRetryableWebhookError("client error", {
        status: 422,
        url: "https://y.example",
        responseBody: "validation failed",
      });
      expect(err.name).toBe("NonRetryableWebhookError");
      expect(err.status).toBe(422);
      expect(err.url).toBe("https://y.example");
      expect(err.responseBody).toBe("validation failed");
      expect(err).toBeInstanceOf(NonRetryableError);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
