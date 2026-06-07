import { describe, expect, it } from "vitest";
import { sign_request } from "../../src/webhook/sign.js";

describe("sign_request", () => {
  it("returns a sha256-prefixed 64-char hex signature", () => {
    const { signature, timestamp } = sign_request(
      "{}",
      "secret",
      1_700_000_000
    );
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(timestamp).toBe("1700000000");
  });

  it("is deterministic — same inputs produce same signature", () => {
    const a = sign_request("hello", "secret", 1_700_000_000);
    const b = sign_request("hello", "secret", 1_700_000_000);
    expect(a.signature).toBe(b.signature);
  });

  it("changes when the secret changes", () => {
    const a = sign_request("hello", "secret-a", 1_700_000_000).signature;
    const b = sign_request("hello", "secret-b", 1_700_000_000).signature;
    expect(a).not.toBe(b);
  });

  it("changes when the body changes", () => {
    const a = sign_request("hello", "secret", 1_700_000_000).signature;
    const b = sign_request("world", "secret", 1_700_000_000).signature;
    expect(a).not.toBe(b);
  });

  it("changes when the timestamp changes", () => {
    const a = sign_request("hello", "secret", 1_700_000_000).signature;
    const b = sign_request("hello", "secret", 1_700_000_001).signature;
    expect(a).not.toBe(b);
  });

  it("emits Unix-seconds wall clock when `now` is omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = sign_request("body", "secret");
    const after = Math.floor(Date.now() / 1000);
    const t = Number.parseInt(timestamp, 10);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
