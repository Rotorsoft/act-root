/**
 * Authenticated envelope encryption with a versioned wire format.
 *
 * Sits between the act framework's port adapters (`act-pg`, `act-sqlite`,
 * future adapters) and an operator-controlled key provider. The framework
 * itself stays unaware of encryption — this package is a leaf-level
 * helper that adapters call from their commit and query paths when an
 * operator opts in via the adapter's `pii_encryption` constructor option.
 *
 * The PII column on `events` is the first caller, but nothing here is
 * PII-specific. Any adapter holding a JSON-serializable column value
 * that wants column-level encryption with operator-controlled keys can
 * use the same primitives.
 *
 * Wire format (base64-encoded on disk):
 *
 *     [version: 1B][iv: 12B][tag: 16B][ciphertext: NB]
 *
 * - `version = 0x01` — AES-256-GCM. The version byte is the only marker
 *   `decrypt` inspects to decide how to unpack; a future algorithm bumps
 *   the byte and gains a new switch arm.
 * - `iv` — 12 random bytes per encryption. GCM's IV-uniqueness contract;
 *   `randomBytes(12)` is collision-safe at any reasonable scale.
 * - `tag` — 16-byte GCM auth tag. `decipher.final()` throws on mismatch,
 *   which `decrypt` surfaces as `DecryptionError`.
 *
 * @packageDocumentation
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Supported algorithm names. Singleton today; widen when a v2 lands.
 * The literal type keeps misspellings out of operator config at
 * compile time.
 */
export type Algorithm = "aes-256-gcm";

/**
 * Operator-supplied configuration for envelope encryption. Adapters
 * accept a value of this shape under whatever option name fits their
 * surface (e.g. `pii_encryption` on `PostgresStore`).
 */
export type Encryption = {
  /**
   * Returns the symmetric key used for both encrypt and decrypt.
   * `makeKeyResolver` calls this once on first use and caches the
   * result for the resolver's lifetime — operators who need rotation
   * restart the adapter with a new provider. Must return a 32-byte
   * Buffer (256 bits) for AES-256-GCM.
   */
  readonly keyProvider: () => Buffer | Promise<Buffer>;
  /** Cipher selection. Locked to `aes-256-gcm` for now. */
  readonly algorithm: Algorithm;
};

const V1_AES_256_GCM = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN; // 29

/**
 * Thrown when `decrypt` can't recover a payload. The message is
 * intentionally generic — the cause (corrupt framing, wrong key,
 * tampered ciphertext) is private so adversarial callers can't probe
 * for which failure mode a given input hit.
 */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * Wrap an {@link Encryption} config into a memoized key resolver.
 *
 * The returned function calls `encryption.keyProvider` on first use,
 * validates the result is a 32-byte Buffer, and caches it for the
 * resolver's lifetime. Subsequent calls hit the cache without
 * re-invoking the provider — important when the provider is a KMS
 * round-trip.
 *
 * Operators who need key rotation construct a new adapter (which makes
 * a new resolver) rather than mutating the in-flight one. The
 * resolver's lifecycle matches the adapter's, not the application's.
 *
 * @throws Error if `keyProvider` returns anything other than a
 *   32-byte Buffer.
 */
export function makeKeyResolver(encryption: Encryption): () => Promise<Buffer> {
  let cached: Buffer | undefined;
  return async () => {
    if (cached) return cached;
    const key = await encryption.keyProvider();
    if (!Buffer.isBuffer(key) || key.length !== KEY_LEN)
      throw new Error(
        `act-crypto: keyProvider must return a ${KEY_LEN}-byte Buffer (AES-256 requires a 256-bit key)`
      );
    cached = key;
    return cached;
  };
}

/**
 * Encrypt a JSON-serializable value into a base64-framed string.
 *
 * The payload is `JSON.stringify`-ed before encryption — callers
 * holding raw bytes wrap them in a JSON-safe form (base64 string,
 * tagged object) before calling.
 *
 * @param payload Anything `JSON.stringify` can serialize. Callers
 *   filter `null`/`undefined` upstream when the storage layer treats
 *   absence specially.
 * @param resolve_key Key resolver from {@link makeKeyResolver}.
 * @returns Base64-encoded framed ciphertext suitable for a text or
 *   jsonb column.
 * @throws Error if `payload` is not JSON-serializable (`undefined`, a
 *   function, or a `Symbol` — anything `JSON.stringify` maps to
 *   `undefined`).
 */
export async function encrypt(
  payload: unknown,
  resolve_key: () => Promise<Buffer>
): Promise<string> {
  const key = await resolve_key();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // JSON.stringify(undefined) and JSON.stringify(fn) both return undefined;
  // Buffer.from(undefined) would throw a raw internal TypeError. Guard here
  // so callers get a clear, validated failure instead.
  const json = JSON.stringify(payload);
  if (json === undefined)
    throw new Error("act-crypto: payload is not JSON-serializable");
  const plaintext = Buffer.from(json, "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([V1_AES_256_GCM]), iv, tag, ct]).toString(
    "base64"
  );
}

/**
 * Decrypt a base64-framed string back into the original JS value.
 *
 * @param encoded Output of a prior {@link encrypt} call.
 * @param resolve_key Key resolver from {@link makeKeyResolver}.
 * @returns The original payload after `JSON.parse`.
 * @throws DecryptionError on:
 *   - input too short to hold the header
 *   - unknown version byte
 *   - GCM auth-tag mismatch (wrong key or tampered ciphertext)
 *   - any decryption-stage failure
 */
export async function decrypt(
  encoded: string,
  resolve_key: () => Promise<Buffer>
): Promise<unknown> {
  const key = await resolve_key();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < HEADER_LEN + 1)
    throw new DecryptionError("ciphertext too short to be valid");
  const version = bytes[0];
  if (version !== V1_AES_256_GCM)
    throw new DecryptionError(
      `ciphertext framing version ${version} is not supported`
    );
  const iv = bytes.subarray(1, 1 + IV_LEN);
  const tag = bytes.subarray(1 + IV_LEN, HEADER_LEN);
  const ct = bytes.subarray(HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf8"));
  } catch {
    throw new DecryptionError(
      "ciphertext failed to decrypt — wrong key, tampered payload, or corrupt framing"
    );
  }
}
