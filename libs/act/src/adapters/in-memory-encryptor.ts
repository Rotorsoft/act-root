import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { Encryptor } from "../types/ports.js";

const MASTER_KEY_BYTES = 32;
const MIN_SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_MAX_ENTRIES = 1_000;
const MAX_MAX_ENTRIES = 10_000_000;
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * Options for the in-process default {@link InMemoryEncryptor}.
 */
export type InMemoryEncryptorOptions = {
  /**
   * 32-byte (256-bit) master key. Required, Buffer only — string overload
   * is deliberately not exposed to avoid base64/hex encoding ambiguity and
   * accidental hardcoded keys in source. Generate via `crypto.randomBytes(32)`
   * and pass through whatever secret-management layer the host already runs
   * (env var, KMS-decrypted secret, Vault read, etc.).
   */
  masterKey: Buffer;

  /**
   * HKDF salt used in the per-stream key derivation. At least 16 bytes when
   * supplied. Defaults to a fresh `crypto.randomBytes(16)` at construction —
   * deterministic operation across process restarts requires passing the
   * same salt explicitly.
   */
  salt?: Buffer;

  /**
   * Maximum number of derived per-stream keys cached in process memory.
   * Default `100_000`. Validated `[1_000, 10_000_000]`. Below 1k thrashes
   * (the cache evicts faster than streams reuse it); above 10M is over a
   * gigabyte of cached keys — well past any business-app workload.
   */
  maxEntries?: number;
};

/**
 * Default in-tree {@link Encryptor} adapter.
 *
 * AES-256-GCM with a 12-byte random IV per encryption and a 16-byte
 * authentication tag. Per-stream keys are derived once per process via
 * HKDF-SHA-256 over `(masterKey, salt, stream)` and cached LRU-style; the
 * HKDF cost (~10μs) amortizes away after the first use per stream.
 *
 * **Single-process only.** The shredded-stream set lives in process memory,
 * which is the load-bearing security mechanism — even if a stream's key is
 * re-derived later (the master key is still present), the cache consults the
 * `shredded` set on every decrypt and returns `undefined`. Multi-process
 * deployments need a durable encryptor (KMS / Vault); use this one in
 * single-node deployments, tests, and as the reference implementation when
 * writing a custom adapter.
 *
 * Ciphertext format: `base64(iv || ct || tag)`. The framework treats the
 * return value of {@link InMemoryEncryptor.encrypt} as opaque; consumers
 * never parse it directly.
 */
export class InMemoryEncryptor implements Encryptor {
  private readonly _masterKey: Buffer;
  private readonly _salt: Buffer;
  private readonly _maxEntries: number;
  private readonly _keyCache: Map<string, Buffer>;
  private readonly _shredded: Set<string>;

  constructor(options: InMemoryEncryptorOptions) {
    if (!Buffer.isBuffer(options.masterKey)) {
      throw new TypeError(
        "InMemoryEncryptor: masterKey must be a Buffer (use crypto.randomBytes(32) or Buffer.from(...))"
      );
    }
    if (options.masterKey.length !== MASTER_KEY_BYTES) {
      throw new RangeError(
        `InMemoryEncryptor: masterKey must be exactly ${MASTER_KEY_BYTES} bytes (256 bits), got ${options.masterKey.length}`
      );
    }
    if (options.salt !== undefined) {
      if (!Buffer.isBuffer(options.salt)) {
        throw new TypeError("InMemoryEncryptor: salt must be a Buffer");
      }
      if (options.salt.length < MIN_SALT_BYTES) {
        throw new RangeError(
          `InMemoryEncryptor: salt must be at least ${MIN_SALT_BYTES} bytes, got ${options.salt.length}`
        );
      }
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (
      !Number.isInteger(maxEntries) ||
      maxEntries < MIN_MAX_ENTRIES ||
      maxEntries > MAX_MAX_ENTRIES
    ) {
      throw new RangeError(
        `InMemoryEncryptor: maxEntries must be an integer in [${MIN_MAX_ENTRIES}, ${MAX_MAX_ENTRIES}], got ${maxEntries}`
      );
    }

    this._masterKey = options.masterKey;
    this._salt = options.salt ?? randomBytes(MIN_SALT_BYTES);
    this._maxEntries = maxEntries;
    this._keyCache = new Map();
    this._shredded = new Set();
  }

  /**
   * Derive (or fetch from cache) the per-stream key. LRU: a cache hit
   * promotes the entry to most-recently-used so the eviction order tracks
   * actual access patterns.
   */
  private deriveKey(stream: string): Buffer {
    const cached = this._keyCache.get(stream);
    if (cached !== undefined) {
      // Reinsert to mark most-recently-used.
      this._keyCache.delete(stream);
      this._keyCache.set(stream, cached);
      return cached;
    }
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        this._masterKey,
        this._salt,
        Buffer.from(stream, "utf8"),
        MASTER_KEY_BYTES
      )
    );
    if (this._keyCache.size >= this._maxEntries) {
      // Map iteration order is insertion-order; the first key is the
      // least-recently-used. Size is bounded below by maxEntries >= 1000
      // here, so the iterator always yields a value — the `as string`
      // cast asserts the contract instead of a defensive null check that
      // can't be tested.
      const oldest = this._keyCache.keys().next().value as string;
      this._keyCache.delete(oldest);
    }
    this._keyCache.set(stream, derived);
    return derived;
  }

  async encrypt(stream: string, plaintext: string): Promise<string> {
    const key = this.deriveKey(stream);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, enc, tag]).toString("base64");
  }

  async decrypt(
    stream: string,
    ciphertext: string
  ): Promise<string | undefined> {
    if (this._shredded.has(stream)) {
      return undefined;
    }
    const buf = Buffer.from(ciphertext, "base64");
    if (buf.length < IV_BYTES + TAG_BYTES) {
      throw new RangeError(
        `InMemoryEncryptor: ciphertext too short (${buf.length} bytes); must be at least ${IV_BYTES + TAG_BYTES}`
      );
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const enc = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
    const key = this.deriveKey(stream);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    // GCM throws on auth tag mismatch — a tampered ciphertext or wrong key.
    // Surface as Error so the read path treats it as a data-integrity issue,
    // distinct from the shredded case (which returns undefined).
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  }

  async shred(stream: string): Promise<void> {
    this._keyCache.delete(stream);
    this._shredded.add(stream);
  }

  async dispose(): Promise<void> {
    this._keyCache.clear();
    this._shredded.clear();
  }
}
