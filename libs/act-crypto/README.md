# @rotorsoft/act-crypto

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-crypto.svg)](https://www.npmjs.com/package/@rotorsoft/act-crypto)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-crypto.svg)](https://www.npmjs.com/package/@rotorsoft/act-crypto)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Authenticated envelope encryption (AES-256-GCM, versioned wire format) for adapters in the [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) ecosystem._

## Why this package

The PII column on `events` is the first caller. `@rotorsoft/act-pg` and `@rotorsoft/act-sqlite` both accept an optional `pii_encryption` constructor option that delegates to this package — the adapter encrypts the column on commit and decrypts on read, with an operator-controlled key.

Adapter-layer encryption fits the deployments TDE and `pgcrypto` can't reach: self-hosted Postgres without extensions, edge SQLite on devices you don't fully control, container and serverless workloads where the volume is opaque. The framework core (`@rotorsoft/act`) stays unaware of cipher, key, or envelope — this is a leaf-level helper, not a port.

Nothing in the package is PII-specific. Any adapter holding a JSON-serializable column value that wants column-level encryption with an operator-controlled key can use the same primitives.

## Installation

```bash
pnpm add @rotorsoft/act-crypto
```

## Quick start

```typescript
import { encrypt, decrypt, makeKeyResolver } from "@rotorsoft/act-crypto";

const resolveKey = makeKeyResolver({
  keyProvider: () => Buffer.from(process.env.PII_KEY_BASE64!, "base64"),
  algorithm: "aes-256-gcm",
});

const encoded = await encrypt({ email: "alice@example.com" }, resolveKey);
// → base64 string; write to a jsonb / TEXT column

const payload = await decrypt(encoded, resolveKey);
// → { email: "alice@example.com" }
```

From an adapter the typical wiring is even thinner — the `pii_encryption` constructor option on `PostgresStore` / `SqliteStore` handles it transparently.

## API

- **`encrypt(payload, resolveKey)`** — encrypts a JSON-serializable value to a base64-framed string.
- **`decrypt(encoded, resolveKey)`** — recovers the original value; throws `DecryptionError` on framing, key, or auth-tag failures.
- **`makeKeyResolver({ keyProvider, algorithm })`** — caches the operator's key on first use for the resolver's lifetime; restart the adapter to rotate.
- **`DecryptionError`** — narrow error class with a generic message (the failure mode is intentionally not exposed).
- **`Encryption`** — operator-supplied configuration type.
- **`Algorithm`** — supported algorithm literal type (singleton today).

Full type reference: [typedoc](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/api/act-crypto/src/README.md).

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `keyProvider` | `() => Buffer \| Promise<Buffer>` | — | Returns the symmetric key; called once on first use and cached. Must return a 32-byte Buffer (AES-256 requires 256 bits). |
| `algorithm` | `"aes-256-gcm"` | — | Cipher selection. Literal type — keeps misspellings out of operator config at compile time. |

A sync provider works for env-var-backed deployments. An async provider fits KMS callbacks — AWS KMS / GCP KMS / Vault `keyProvider` callbacks return `Promise<Buffer>`.

## Wire format

Base64-encoded on disk:

```
[version: 1 byte = 0x01][iv: 12 bytes][gcm tag: 16 bytes][ciphertext: NB]
```

- `version = 0x01` — AES-256-GCM. The version byte is the only marker `decrypt` inspects; a future algorithm bumps the byte and gains a new switch arm without breaking existing rows.
- `iv` — 12 random bytes per encryption, generated via `randomBytes(12)`. GCM's IV-uniqueness contract — collision-safe at any reasonable scale.
- `tag` — 16-byte GCM auth tag. `decipher.final()` throws on mismatch, surfaced as `DecryptionError`.

## Common patterns

### Mixed-data rollout (adopting encryption on an existing column)

The adapter's read path discriminates by type — strings get decrypted, objects pass through as plaintext. Rows written before enabling encryption keep reading cleanly; new writes land as ciphertext. No backfill needed; no migration step.

### Rotation

`makeKeyResolver` caches the key for the resolver's lifetime. To rotate, restart the adapter with a fresh `keyProvider`. Mid-flight key changes are not supported — re-encrypt is an operator concern.

### Defense in depth

Composes with TDE / `pgcrypto` / SQLite SEE / OS-level FDE. The adapter encrypts the column; the database or volume encrypts the bytes. Use both layers when the compliance regime demands it; one is fine when it doesn't.

## What this package deliberately doesn't ship

- No key management — no KEK/DEK split, no rotation tooling, no audit trail.
- No KMS integration — `keyProvider` is the integration point; you wire it.
- No application-layer crypto for `events.data` — that's what `events.pii` is for. Use `sensitive(...)` to declare which fields live in the PII column, then encrypt at this layer or below.
- No cipher choice beyond `aes-256-gcm` — authenticated encryption is non-negotiable for sensitive data, and offering options mostly invites footguns.

## Compatibility

- **Node**: >=22.18.0
- **Bundled deps**: none. Pure `node:crypto`.
- **Module formats**: ESM (`import`) and CJS (`require`). No side effects.

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). `encrypt` / `decrypt` are stable wire-format primitives — the version byte is the upgrade path. Charter is **in effect as of 1.0.0**; the milestone tracker is [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the event-sourcing framework whose sensitive-data surface (`sensitive(...)`, `.discloses(...)`, `app.forget(...)`) the encryption shell sits behind.
- **[@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg)** / **[@rotorsoft/act-sqlite](https://www.npmjs.com/package/@rotorsoft/act-sqlite)** — production `Store` adapters. Both accept `pii_encryption` to wire this package's primitives into their commit / query paths.
- **[@rotorsoft/act-tck](https://www.npmjs.com/package/@rotorsoft/act-tck)** — `pii_isolation` capability tests. Encryption is orthogonal to the capability and not part of the TCK.

## Documentation

- **[PII encryption at rest](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/pii-encryption-at-rest.md)** — operator cookbook covering the five common patterns (pgcrypto, RDS TDE, Cloud SQL TDE, SQLite SEE, adapter-layer envelope encryption via this package).
- **[Handling sensitive data](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/sensitive-data.md)** — declarative surface (`sensitive(...)`, `.discloses(...)`, `app.forget(...)`) the column encryption sits underneath.

## License

MIT
