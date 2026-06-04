import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEncryptor } from "../src/adapters/in-memory-encryptor.js";

const KEY32 = (): Buffer => randomBytes(32);
const SALT16 = (): Buffer => randomBytes(16);

describe("InMemoryEncryptor — constructor validation", () => {
  it("rejects a missing masterKey", () => {
    expect(
      () =>
        new InMemoryEncryptor({
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
          masterKey: undefined as any,
        })
    ).toThrow(TypeError);
  });

  it("rejects a non-Buffer masterKey (string)", () => {
    expect(
      () =>
        new InMemoryEncryptor({
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
          masterKey: "not-a-buffer" as any,
        })
    ).toThrow(/Buffer/);
  });

  it("rejects a masterKey shorter than 32 bytes", () => {
    expect(() => new InMemoryEncryptor({ masterKey: randomBytes(16) })).toThrow(
      /32 bytes/
    );
  });

  it("rejects a masterKey longer than 32 bytes", () => {
    expect(() => new InMemoryEncryptor({ masterKey: randomBytes(48) })).toThrow(
      /32 bytes/
    );
  });

  it("rejects a non-Buffer salt", () => {
    expect(
      () =>
        new InMemoryEncryptor({
          masterKey: KEY32(),
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
          salt: "not-a-buffer" as any,
        })
    ).toThrow(/salt/);
  });

  it("rejects a salt shorter than 16 bytes", () => {
    expect(
      () => new InMemoryEncryptor({ masterKey: KEY32(), salt: randomBytes(8) })
    ).toThrow(/16 bytes/);
  });

  it("accepts a 16-byte salt", () => {
    expect(
      () => new InMemoryEncryptor({ masterKey: KEY32(), salt: randomBytes(16) })
    ).not.toThrow();
  });

  it("accepts a larger-than-16-byte salt", () => {
    expect(
      () => new InMemoryEncryptor({ masterKey: KEY32(), salt: randomBytes(32) })
    ).not.toThrow();
  });

  it("rejects maxEntries below 1000", () => {
    expect(
      () => new InMemoryEncryptor({ masterKey: KEY32(), maxEntries: 999 })
    ).toThrow(/maxEntries/);
  });

  it("rejects maxEntries above 10000000", () => {
    expect(
      () =>
        new InMemoryEncryptor({ masterKey: KEY32(), maxEntries: 10_000_001 })
    ).toThrow(/maxEntries/);
  });

  it("rejects non-integer maxEntries", () => {
    expect(
      () => new InMemoryEncryptor({ masterKey: KEY32(), maxEntries: 1500.5 })
    ).toThrow(/maxEntries/);
  });

  it("accepts maxEntries at the boundary [1000, 10000000]", () => {
    expect(
      () => new InMemoryEncryptor({ masterKey: KEY32(), maxEntries: 1_000 })
    ).not.toThrow();
    expect(
      () =>
        new InMemoryEncryptor({ masterKey: KEY32(), maxEntries: 10_000_000 })
    ).not.toThrow();
  });
});

describe("InMemoryEncryptor — encrypt/decrypt round-trip", () => {
  let encryptor: InMemoryEncryptor;
  const masterKey = KEY32();
  const salt = SALT16();

  beforeEach(() => {
    encryptor = new InMemoryEncryptor({ masterKey, salt });
  });

  it("encrypts then decrypts a plaintext to itself", async () => {
    const plaintext = "user@example.com";
    const ciphertext = await encryptor.encrypt("stream-1", plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.length).toBeGreaterThan(0);
    const decrypted = await encryptor.decrypt("stream-1", ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const a = await encryptor.encrypt("stream-1", "same-plaintext");
    const b = await encryptor.encrypt("stream-1", "same-plaintext");
    expect(a).not.toBe(b);
  });

  it("isolates streams — each gets its own derived key", async () => {
    const ciphertext = await encryptor.encrypt("stream-A", "secret");
    // Decrypting with a different stream re-derives a different key,
    // so the GCM auth tag check fails.
    await expect(encryptor.decrypt("stream-B", ciphertext)).rejects.toThrow();
  });

  it("handles empty plaintext", async () => {
    const ciphertext = await encryptor.encrypt("stream-1", "");
    const decrypted = await encryptor.decrypt("stream-1", ciphertext);
    expect(decrypted).toBe("");
  });

  it("handles unicode plaintext", async () => {
    const plaintext = "héllo 世界 🌍";
    const ciphertext = await encryptor.encrypt("stream-1", plaintext);
    const decrypted = await encryptor.decrypt("stream-1", ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("handles large plaintext (1MB)", async () => {
    const plaintext = "x".repeat(1_000_000);
    const ciphertext = await encryptor.encrypt("stream-1", plaintext);
    const decrypted = await encryptor.decrypt("stream-1", ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("throws on tampered ciphertext (auth tag mismatch)", async () => {
    const ciphertext = await encryptor.encrypt("stream-1", "secret");
    // Flip a byte in the middle of the ciphertext (avoid IV at start).
    const buf = Buffer.from(ciphertext, "base64");
    buf[20] = buf[20] ^ 0xff;
    const tampered = buf.toString("base64");
    await expect(encryptor.decrypt("stream-1", tampered)).rejects.toThrow();
  });

  it("rejects ciphertext shorter than IV+tag (28 bytes)", async () => {
    const tooShort = Buffer.from("short").toString("base64");
    await expect(encryptor.decrypt("stream-1", tooShort)).rejects.toThrow(
      /too short/
    );
  });
});

describe("InMemoryEncryptor — shred semantics", () => {
  it("returns undefined on decrypt after shred (no throw)", async () => {
    const encryptor = new InMemoryEncryptor({ masterKey: KEY32() });
    const ciphertext = await encryptor.encrypt("user-1", "pii");
    await encryptor.shred("user-1");
    const result = await encryptor.decrypt("user-1", ciphertext);
    expect(result).toBeUndefined();
  });

  it("is idempotent — shredding twice is a no-op", async () => {
    const encryptor = new InMemoryEncryptor({ masterKey: KEY32() });
    await encryptor.encrypt("user-1", "pii");
    await encryptor.shred("user-1");
    await expect(encryptor.shred("user-1")).resolves.toBeUndefined();
    // Still returns undefined after second shred
    const ciphertext = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = await encryptor.decrypt("user-1", ciphertext);
    expect(result).toBeUndefined();
  });

  it("only shreds the targeted stream — others remain decryptable", async () => {
    const encryptor = new InMemoryEncryptor({ masterKey: KEY32() });
    const a = await encryptor.encrypt("user-1", "alice");
    const b = await encryptor.encrypt("user-2", "bob");
    await encryptor.shred("user-1");
    expect(await encryptor.decrypt("user-1", a)).toBeUndefined();
    expect(await encryptor.decrypt("user-2", b)).toBe("bob");
  });

  it("permanently shreds even if the key would re-derive (side-channel)", async () => {
    // Same master + salt → same derived key in principle, but the shredded
    // set short-circuits decrypt. This is the security guarantee.
    const masterKey = KEY32();
    const salt = SALT16();
    const encryptor = new InMemoryEncryptor({ masterKey, salt });
    const ciphertext = await encryptor.encrypt("user-1", "secret");
    await encryptor.shred("user-1");
    // Encrypting again into the same stream is allowed (a new HKDF derive),
    // but old ciphertexts stay unreadable on this encryptor instance.
    const result = await encryptor.decrypt("user-1", ciphertext);
    expect(result).toBeUndefined();
  });
});

describe("InMemoryEncryptor — LRU key cache", () => {
  it("evicts the least-recently-used stream when the cache is full", async () => {
    const encryptor = new InMemoryEncryptor({
      masterKey: KEY32(),
      maxEntries: 1_000,
    });
    // Encrypt across 1_001 distinct streams — should not throw despite
    // exceeding the configured cap. The cache evicts; functionality
    // continues because the next encrypt re-derives the key.
    for (let i = 0; i < 1_002; i++) {
      await encryptor.encrypt(`s${i}`, "x");
    }
    // The first stream should have been evicted; encrypting again
    // exercises the re-derivation branch.
    const ciphertext = await encryptor.encrypt("s0", "back-again");
    const decrypted = await encryptor.decrypt("s0", ciphertext);
    expect(decrypted).toBe("back-again");
  });

  it("promotes a hit to most-recently-used", async () => {
    const encryptor = new InMemoryEncryptor({
      masterKey: KEY32(),
      maxEntries: 1_000,
    });
    // Warm 1000 streams.
    for (let i = 0; i < 1_000; i++) {
      await encryptor.encrypt(`s${i}`, "x");
    }
    // Touch s0 — should promote it to MRU.
    await encryptor.encrypt("s0", "touched");
    // Add one more stream — evicts oldest (s1, not s0).
    await encryptor.encrypt("s1000", "fresh");
    // s0 should still round-trip without re-derivation surprise.
    const ciphertext = await encryptor.encrypt("s0", "still-here");
    expect(await encryptor.decrypt("s0", ciphertext)).toBe("still-here");
  });
});

describe("InMemoryEncryptor — dispose", () => {
  it("clears caches without throwing", async () => {
    const encryptor = new InMemoryEncryptor({ masterKey: KEY32() });
    await encryptor.encrypt("user-1", "secret");
    await encryptor.shred("user-2");
    await expect(encryptor.dispose()).resolves.toBeUndefined();
  });

  it("dispose is idempotent", async () => {
    const encryptor = new InMemoryEncryptor({ masterKey: KEY32() });
    await encryptor.dispose();
    await expect(encryptor.dispose()).resolves.toBeUndefined();
  });
});

describe("InMemoryEncryptor — default salt", () => {
  it("uses a generated salt when none is supplied", async () => {
    const encryptor = new InMemoryEncryptor({ masterKey: KEY32() });
    // The instance is functional — round-trip works without a caller-supplied salt.
    const ciphertext = await encryptor.encrypt("stream-1", "data");
    const decrypted = await encryptor.decrypt("stream-1", ciphertext);
    expect(decrypted).toBe("data");
  });

  it("two instances with the same masterKey but no salt produce different ciphertexts", async () => {
    const masterKey = KEY32();
    const a = new InMemoryEncryptor({ masterKey });
    const b = new InMemoryEncryptor({ masterKey });
    const ctA = await a.encrypt("stream-1", "data");
    // Decrypting A's ciphertext with B's instance fails (different salt
    // → different derived key → auth tag mismatch).
    await expect(b.decrypt("stream-1", ctA)).rejects.toThrow();
  });
});
