import { NonRetryableError } from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { classify_http_response, try_ok } from "../../src/webhook/classify.js";
import {
  NonRetryableHttpError,
  NonRetryableWebhookError,
  RetryableHttpError,
  WebhookError,
} from "../../src/webhook/types.js";

function response(status: number, body?: string): Response {
  return new Response(body ?? null, { status });
}

describe("classify_http_response", () => {
  describe("ok (2xx)", () => {
    it("classifies 200 as ok", () => {
      expect(classify_http_response(response(200))).toBe("ok");
    });

    it("classifies 204 as ok", () => {
      expect(classify_http_response(response(204))).toBe("ok");
    });
  });

  describe("retry (5xx)", () => {
    it("classifies 500 as retry", () => {
      expect(classify_http_response(response(500))).toBe("retry");
    });

    it("classifies 503 as retry", () => {
      expect(classify_http_response(response(503))).toBe("retry");
    });
  });

  describe("block (3xx, 4xx)", () => {
    it("classifies 301 as block", () => {
      expect(classify_http_response(response(301))).toBe("block");
    });

    it("classifies 400 as block", () => {
      expect(classify_http_response(response(400))).toBe("block");
    });

    it("classifies 403 as block", () => {
      expect(classify_http_response(response(403))).toBe("block");
    });

    it("classifies 422 as block", () => {
      expect(classify_http_response(response(422))).toBe("block");
    });
  });
});

describe("try_ok", () => {
  describe("ok (2xx)", () => {
    it("returns undefined on 200", async () => {
      await expect(
        try_ok(response(200), { url: "https://x.example" })
      ).resolves.toBeUndefined();
    });

    it("returns undefined on 204", async () => {
      await expect(
        try_ok(response(204), { url: "https://x.example" })
      ).resolves.toBeUndefined();
    });
  });

  describe("retry (5xx)", () => {
    it("throws RetryableHttpError on 500", async () => {
      try {
        await try_ok(response(500), { url: "https://x.example" });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RetryableHttpError);
        expect(err).not.toBeInstanceOf(NonRetryableError);
        const e = err as RetryableHttpError;
        expect(e.status).toBe(500);
        expect(e.url).toBe("https://x.example");
      }
    });

    it("includes the response body in the thrown error", async () => {
      try {
        await try_ok(response(503, "service unavailable"), {
          url: "https://x.example",
        });
        throw new Error("expected throw");
      } catch (err) {
        const e = err as RetryableHttpError;
        expect(e.response_body).toBe("service unavailable");
      }
    });
  });

  describe("block (3xx, 4xx)", () => {
    it("throws NonRetryableHttpError on 400", async () => {
      try {
        await try_ok(response(400, "bad request"), {
          url: "https://x.example",
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(NonRetryableHttpError);
        expect(err).toBeInstanceOf(NonRetryableError);
        const e = err as NonRetryableHttpError;
        expect(e.status).toBe(400);
        expect(e.response_body).toBe("bad request");
      }
    });

    it("throws NonRetryableHttpError on 301", async () => {
      try {
        await try_ok(response(301), { url: "https://x.example" });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(NonRetryableHttpError);
        const e = err as NonRetryableHttpError;
        expect(e.status).toBe(301);
      }
    });
  });

  describe("message formatting", () => {
    it("prefixes the message with the caller-supplied label", async () => {
      try {
        await try_ok(response(500), {
          url: "https://x.example",
          label: "my_sdk",
        });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as Error).message).toBe(
          "my_sdk https://x.example responded 500"
        );
      }
    });

    it("defaults the label to 'request' when omitted", async () => {
      try {
        await try_ok(response(503), { url: "https://x.example" });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as Error).message).toBe(
          "request https://x.example responded 503"
        );
      }
    });
  });

  describe("body capture", () => {
    it("silently omits response_body when the body read throws", async () => {
      // A Response whose text() rejects — simulate via a mock.
      const flaky = {
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error("stream error")),
      } as unknown as Response;
      try {
        await try_ok(flaky, { url: "https://x.example" });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as RetryableHttpError).response_body).toBeUndefined();
      }
    });
  });
});

describe("error class inheritance", () => {
  it("WebhookError extends RetryableHttpError (backward compat)", () => {
    const err = new WebhookError("boom", {
      status: 500,
      url: "https://x.example",
    });
    expect(err).toBeInstanceOf(WebhookError);
    expect(err).toBeInstanceOf(RetryableHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(err.name).toBe("WebhookError");
  });

  it("NonRetryableWebhookError extends NonRetryableHttpError", () => {
    const err = new NonRetryableWebhookError("client error", {
      status: 422,
      url: "https://y.example",
    });
    expect(err).toBeInstanceOf(NonRetryableWebhookError);
    expect(err).toBeInstanceOf(NonRetryableHttpError);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.name).toBe("NonRetryableWebhookError");
  });

  it("RetryableHttpError carries the same fields as WebhookError", () => {
    const err = new RetryableHttpError("boom", {
      status: 502,
      url: "https://x.example",
      response_body: "bad gateway",
    });
    expect(err.status).toBe(502);
    expect(err.url).toBe("https://x.example");
    expect(err.response_body).toBe("bad gateway");
    expect(err.name).toBe("RetryableHttpError");
  });

  it("NonRetryableHttpError carries the same fields as NonRetryableWebhookError", () => {
    const err = new NonRetryableHttpError("bad", {
      status: 422,
      url: "https://y.example",
      response_body: "validation failed",
    });
    expect(err.status).toBe(422);
    expect(err.url).toBe("https://y.example");
    expect(err.response_body).toBe("validation failed");
    expect(err.name).toBe("NonRetryableHttpError");
  });
});
