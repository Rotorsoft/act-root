import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { describe, expect, it } from "vitest";
import { checkWebhook } from "../../src/receiver/check.js";
import { signRequest } from "../../src/webhook/sign.js";

const SECRET = "test-secret";
const BODY = '{"orderId":"o-1"}';
const NOW = 1_700_000_000;

function freshStore() {
  return new InMemoryIdempotencyStore();
}

function signedHeaders(at: number = NOW, body: string = BODY) {
  const { signature, timestamp } = signRequest(body, SECRET, at);
  return {
    "x-webhook-signature": signature,
    "x-webhook-timestamp": timestamp,
    "idempotency-key": "req-1",
  };
}

describe("checkWebhook", () => {
  describe("happy path", () => {
    it("returns { ok: true, key, deduped: false } on first claim with no secret", async () => {
      const store = freshStore();
      const headers = { "idempotency-key": "req-1" };
      const result = await checkWebhook(headers, BODY, { store });
      expect(result).toEqual({ ok: true, key: "req-1", deduped: false });
    });

    it("returns { ok: true, ..., deduped: true } on second claim with same key", async () => {
      const store = freshStore();
      const headers = { "idempotency-key": "req-1" };
      const first = await checkWebhook(headers, BODY, { store });
      const second = await checkWebhook(headers, BODY, { store });
      expect(first).toEqual({ ok: true, key: "req-1", deduped: false });
      expect(second).toEqual({ ok: true, key: "req-1", deduped: true });
    });

    it("verifies signature when secret is set", async () => {
      const store = freshStore();
      const headers = signedHeaders(NOW);
      const result = await checkWebhook(headers, BODY, {
        store,
        secret: SECRET,
        verify: { now: NOW },
      });
      expect(result).toEqual({ ok: true, key: "req-1", deduped: false });
    });
  });

  describe("missing-key (400)", () => {
    it("rejects with status 400 when Idempotency-Key is absent", async () => {
      const store = freshStore();
      const result = await checkWebhook({}, BODY, { store });
      expect(result).toEqual({
        ok: false,
        status: 400,
        reason: "missing-key",
      });
    });

    it("rejects when Idempotency-Key is empty", async () => {
      const store = freshStore();
      const headers = { "idempotency-key": "" };
      const result = await checkWebhook(headers, BODY, { store });
      expect(result).toEqual({
        ok: false,
        status: 400,
        reason: "missing-key",
      });
    });
  });

  describe("verification failures (401)", () => {
    it("forwards missing-signature", async () => {
      const store = freshStore();
      const headers = { "idempotency-key": "req-1" };
      const result = await checkWebhook(headers, BODY, {
        store,
        secret: SECRET,
        verify: { now: NOW },
      });
      expect(result).toEqual({
        ok: false,
        status: 401,
        reason: "missing-signature",
      });
    });

    it("forwards stale", async () => {
      const store = freshStore();
      const headers = signedHeaders(NOW - 600);
      const result = await checkWebhook(headers, BODY, {
        store,
        secret: SECRET,
        verify: { now: NOW, maxAgeSeconds: 300 },
      });
      expect(result).toEqual({ ok: false, status: 401, reason: "stale" });
    });

    it("forwards bad-signature", async () => {
      const store = freshStore();
      const headers = signedHeaders(NOW);
      const result = await checkWebhook(headers, "tampered-body", {
        store,
        secret: SECRET,
        verify: { now: NOW },
      });
      expect(result).toEqual({
        ok: false,
        status: 401,
        reason: "bad-signature",
      });
    });
  });

  describe("check ordering", () => {
    it("rejects on bad signature before claiming the key (no dedup pollution)", async () => {
      const store = freshStore();
      const headers = signedHeaders(NOW);
      // Same key, tampered body — verification fails. The key must
      // not be claimed; a follow-up with a valid signature and the
      // same key should still succeed as `deduped: false`.
      await checkWebhook(headers, "tampered-body", {
        store,
        secret: SECRET,
        verify: { now: NOW },
      });
      const validResult = await checkWebhook(headers, BODY, {
        store,
        secret: SECRET,
        verify: { now: NOW },
      });
      expect(validResult).toEqual({
        ok: true,
        key: "req-1",
        deduped: false,
      });
    });

    it("rejects on missing key after verification passes (does not claim)", async () => {
      const store = freshStore();
      const headers = signRequest(BODY, SECRET, NOW);
      const headersBag = {
        "x-webhook-signature": headers.signature,
        "x-webhook-timestamp": headers.timestamp,
      };
      const result = await checkWebhook(headersBag, BODY, {
        store,
        secret: SECRET,
        verify: { now: NOW },
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        reason: "missing-key",
      });
      // Store is still empty — verification passed but no key was claimed.
      expect(store.size()).toBe(0);
    });
  });
});
