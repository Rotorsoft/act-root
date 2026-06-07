import { describe, expect, it } from "vitest";
import { verifyWebhook } from "../../src/receiver/index.js";
import { sign_request } from "../../src/webhook/sign.js";

const SECRET = "test-secret";
const BODY = '{"order_id":"o-1"}';
const NOW = 1_700_000_000;

/** Build a headers bag for a request signed at `signedAt` with the test secret. */
function signedHeaders(
  signedAt: number,
  body: string = BODY,
  secret: string = SECRET
) {
  const { signature, timestamp } = sign_request(body, secret, signedAt);
  return {
    "x-webhook-signature": signature,
    "x-webhook-timestamp": timestamp,
  };
}

describe("verifyWebhook", () => {
  describe("happy path", () => {
    it("returns { ok: true } when signature and timestamp are valid", () => {
      const headers = signedHeaders(NOW);
      const result = verifyWebhook(headers, BODY, SECRET, { now: NOW });
      expect(result).toEqual({ ok: true });
    });

    it("accepts case-insensitive header names", () => {
      const { signature, timestamp } = sign_request(BODY, SECRET, NOW);
      const result = verifyWebhook(
        {
          "X-Webhook-Signature": signature,
          "X-Webhook-Timestamp": timestamp,
        },
        BODY,
        SECRET,
        { now: NOW }
      );
      expect(result).toEqual({ ok: true });
    });
  });

  describe("missing-signature", () => {
    it("rejects when the signature header is absent", () => {
      const { timestamp } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook({ "x-webhook-timestamp": timestamp }, BODY, SECRET, {
          now: NOW,
        })
      ).toEqual({ ok: false, reason: "missing-signature" });
    });

    it("rejects when the signature header is array-valued", () => {
      const { timestamp } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          {
            "x-webhook-signature": ["sha256=abc", "sha256=def"],
            "x-webhook-timestamp": timestamp,
          },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "missing-signature" });
    });

    it("rejects when the signature header is empty", () => {
      const { timestamp } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          { "x-webhook-signature": "", "x-webhook-timestamp": timestamp },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "missing-signature" });
    });

    it("rejects when the signature header is undefined", () => {
      const { timestamp } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          {
            "x-webhook-signature": undefined,
            "x-webhook-timestamp": timestamp,
          },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "missing-signature" });
    });
  });

  describe("missing-timestamp", () => {
    it("rejects when the timestamp header is absent", () => {
      const { signature } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook({ "x-webhook-signature": signature }, BODY, SECRET, {
          now: NOW,
        })
      ).toEqual({ ok: false, reason: "missing-timestamp" });
    });

    it("rejects when the timestamp isn't a parseable integer", () => {
      const { signature } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          {
            "x-webhook-signature": signature,
            "x-webhook-timestamp": "not-a-number",
          },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "missing-timestamp" });
    });

    it("rejects timestamps with trailing garbage (round-trip mismatch)", () => {
      const { signature } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          {
            "x-webhook-signature": signature,
            "x-webhook-timestamp": "1700000000abc",
          },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "missing-timestamp" });
    });
  });

  describe("stale / future", () => {
    it("rejects timestamps older than maxAgeSeconds", () => {
      const headers = signedHeaders(NOW - 600);
      expect(
        verifyWebhook(headers, BODY, SECRET, {
          now: NOW,
          maxAgeSeconds: 300,
        })
      ).toEqual({ ok: false, reason: "stale" });
    });

    it("rejects timestamps further in the future than maxAgeSeconds", () => {
      const headers = signedHeaders(NOW + 600);
      expect(
        verifyWebhook(headers, BODY, SECRET, {
          now: NOW,
          maxAgeSeconds: 300,
        })
      ).toEqual({ ok: false, reason: "future" });
    });

    it("accepts timestamps inside the configured window", () => {
      const headers = signedHeaders(NOW - 299);
      expect(
        verifyWebhook(headers, BODY, SECRET, {
          now: NOW,
          maxAgeSeconds: 300,
        })
      ).toEqual({ ok: true });
    });

    it("honors caller-supplied maxAgeSeconds (tighter window)", () => {
      const headers = signedHeaders(NOW - 60);
      expect(
        verifyWebhook(headers, BODY, SECRET, { now: NOW, maxAgeSeconds: 30 })
      ).toEqual({ ok: false, reason: "stale" });
    });
  });

  describe("bad-signature", () => {
    it("rejects signatures without the sha256= prefix", () => {
      const { timestamp } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          {
            "x-webhook-signature": "a".repeat(64),
            "x-webhook-timestamp": timestamp,
          },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "bad-signature" });
    });

    it("rejects signatures whose hex isn't 64 chars", () => {
      const { timestamp } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          {
            "x-webhook-signature": "sha256=deadbeef",
            "x-webhook-timestamp": timestamp,
          },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "bad-signature" });
    });

    it("rejects signatures with non-hex characters", () => {
      const { timestamp } = sign_request(BODY, SECRET, NOW);
      expect(
        verifyWebhook(
          {
            "x-webhook-signature": `sha256=${"g".repeat(64)}`,
            "x-webhook-timestamp": timestamp,
          },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "bad-signature" });
    });

    it("rejects when the recomputed HMAC doesn't match (wrong secret)", () => {
      const headers = signedHeaders(NOW, BODY, "wrong-secret");
      expect(verifyWebhook(headers, BODY, SECRET, { now: NOW })).toEqual({
        ok: false,
        reason: "bad-signature",
      });
    });

    it("rejects when the body was tampered with after signing", () => {
      const headers = signedHeaders(NOW, BODY);
      expect(
        verifyWebhook(headers, '{"order_id":"o-2"}', SECRET, { now: NOW })
      ).toEqual({ ok: false, reason: "bad-signature" });
    });

    it("rejects when the timestamp was rewritten after signing", () => {
      const headers = signedHeaders(NOW);
      // Caller swaps timestamp but keeps the original signature —
      // recomputed HMAC won't match the new timestamp.
      expect(
        verifyWebhook(
          { ...headers, "x-webhook-timestamp": String(NOW - 30) },
          BODY,
          SECRET,
          { now: NOW }
        )
      ).toEqual({ ok: false, reason: "bad-signature" });
    });
  });

  describe("defaults", () => {
    it("uses wall-clock time when `now` is omitted", () => {
      const wallclockNow = Math.floor(Date.now() / 1000);
      const headers = signedHeaders(wallclockNow);
      expect(verifyWebhook(headers, BODY, SECRET)).toEqual({ ok: true });
    });

    it("defaults maxAgeSeconds to 300", () => {
      const headers = signedHeaders(NOW - 299);
      // No maxAgeSeconds passed — must still pass at 299s old.
      expect(verifyWebhook(headers, BODY, SECRET, { now: NOW })).toEqual({
        ok: true,
      });
    });
  });
});
