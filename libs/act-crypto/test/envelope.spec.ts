/**
 * Coverage targets:
 * - encrypt/decrypt round-trip for assorted JSON-serializable payloads
 * - decrypt fault injection: short input, bad version byte, wrong key
 *   (auth tag mismatch), tampered ciphertext
 * - makeKeyResolver: caches, validates key length + Buffer-ness, supports
 *   sync and async providers
 * - DecryptionError: constructor name
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DecryptionError,
  decrypt,
  encrypt,
  makeKeyResolver,
} from "../src/envelope.js";

function makeKey(): Buffer {
  return randomBytes(32);
}

describe("makeKeyResolver", () => {
  it("calls keyProvider once and caches the result", async () => {
    const key = makeKey();
    const provider = vi.fn(async () => key);
    const resolve = makeKeyResolver({
      keyProvider: provider,
      algorithm: "aes-256-gcm",
    });

    expect(await resolve()).toBe(key);
    expect(await resolve()).toBe(key);
    expect(await resolve()).toBe(key);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("accepts a synchronous keyProvider", async () => {
    const key = makeKey();
    const resolve = makeKeyResolver({
      keyProvider: () => key,
      algorithm: "aes-256-gcm",
    });

    expect(await resolve()).toBe(key);
  });

  it("rejects a key that is not a Buffer", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => "not-a-buffer" as unknown as Buffer,
      algorithm: "aes-256-gcm",
    });

    await expect(resolve()).rejects.toThrow(/must return a 32-byte Buffer/);
  });

  it("rejects a key with the wrong length", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => randomBytes(16), // AES-128 key, not 256
      algorithm: "aes-256-gcm",
    });

    await expect(resolve()).rejects.toThrow(/must return a 32-byte Buffer/);
  });
});

describe("encrypt / decrypt round-trip", () => {
  it("round-trips an object payload", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    const original = { email: "alice@example.com", tier: "gold" };
    const encoded = await encrypt(original, resolve);
    expect(typeof encoded).toBe("string");
    expect(await decrypt(encoded, resolve)).toEqual(original);
  });

  it("round-trips a nested object with arrays", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    const original = {
      profile: { name: "Bob", tags: ["x", "y", "z"] },
      counters: [1, 2, 3],
    };
    const encoded = await encrypt(original, resolve);
    expect(await decrypt(encoded, resolve)).toEqual(original);
  });

  it("round-trips primitive payloads", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    for (const original of ["hello", 42, true, null]) {
      const encoded = await encrypt(original, resolve);
      expect(await decrypt(encoded, resolve)).toEqual(original);
    }
  });

  it("produces a different ciphertext for the same payload across calls (IV uniqueness)", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    const original = { stable: "input" };
    const a = await encrypt(original, resolve);
    const b = await encrypt(original, resolve);
    expect(a).not.toBe(b);
    expect(await decrypt(a, resolve)).toEqual(original);
    expect(await decrypt(b, resolve)).toEqual(original);
  });

  it("rejects a payload that is not JSON-serializable with a validated message", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    // JSON.stringify(undefined) === undefined and JSON.stringify(fn) ===
    // undefined — Buffer.from(undefined) throws a raw internal TypeError
    // today; after the guard it must be a clear "not JSON-serializable".
    await expect(encrypt(undefined, resolve)).rejects.toThrow(
      "act-crypto: payload is not JSON-serializable"
    );
    await expect(encrypt(() => 1, resolve)).rejects.toThrow(
      "act-crypto: payload is not JSON-serializable"
    );
  });
});

describe("decrypt fault injection", () => {
  it("throws DecryptionError when the input is too short to be valid framing", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    const tooShort = Buffer.alloc(10).toString("base64");
    await expect(decrypt(tooShort, resolve)).rejects.toBeInstanceOf(
      DecryptionError
    );
    await expect(decrypt(tooShort, resolve)).rejects.toThrow(/too short/);
  });

  it("throws DecryptionError on an unknown version byte", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    // 30 bytes total — passes the length check — but version byte is 0xFF.
    const blob = Buffer.concat([Buffer.from([0xff]), randomBytes(29)]);
    await expect(decrypt(blob.toString("base64"), resolve)).rejects.toThrow(
      /framing version 255/
    );
  });

  it("throws DecryptionError on auth-tag mismatch (wrong key)", async () => {
    const writeKey = makeKey();
    const readKey = makeKey(); // different
    const writeResolve = makeKeyResolver({
      keyProvider: () => writeKey,
      algorithm: "aes-256-gcm",
    });
    const readResolve = makeKeyResolver({
      keyProvider: () => readKey,
      algorithm: "aes-256-gcm",
    });

    const encoded = await encrypt({ secret: "value" }, writeResolve);
    await expect(decrypt(encoded, readResolve)).rejects.toBeInstanceOf(
      DecryptionError
    );
  });

  it("throws DecryptionError on tampered ciphertext", async () => {
    const resolve = makeKeyResolver({
      keyProvider: () => makeKey(),
      algorithm: "aes-256-gcm",
    });
    const encoded = await encrypt({ secret: "value" }, resolve);
    const bytes = Buffer.from(encoded, "base64");
    // Flip a bit in the ciphertext region (past the 29-byte header).
    bytes[bytes.length - 1] ^= 0x01;
    await expect(
      decrypt(bytes.toString("base64"), resolve)
    ).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("DecryptionError", () => {
  it("sets the error name", () => {
    const err = new DecryptionError("boom");
    expect(err.name).toBe("DecryptionError");
    expect(err.message).toBe("boom");
    expect(err).toBeInstanceOf(Error);
  });
});
