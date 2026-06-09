# @rotorsoft/act-crypto

Authenticated envelope encryption for act adapter packages. AES-256-GCM with a versioned wire format, operator-controlled keys, and a memoized key resolver.

This package is a leaf-level helper for **adapters** (`@rotorsoft/act-pg`, `@rotorsoft/act-sqlite`, future stores). The framework core (`@rotorsoft/act`) stays unaware of encryption — adapters call `encrypt` and `decrypt` from their commit and query paths when an operator opts in via the adapter's encryption config.

The PII column on `events` is the first caller, but nothing in the package is PII-specific. Any adapter holding a JSON-serializable column value that wants column-level encryption with operator-controlled keys can use the same primitives.

## Install

```bash
pnpm add @rotorsoft/act-crypto
```

## Use from an adapter

```ts
import { encrypt, decrypt, makeKeyResolver } from "@rotorsoft/act-crypto";

const resolveKey = makeKeyResolver({
  keyProvider: () => process.env.PII_KEY_BASE64
    ? Buffer.from(process.env.PII_KEY_BASE64, "base64")
    : Promise.reject(new Error("PII_KEY_BASE64 is not set")),
  algorithm: "aes-256-gcm",
});

// On commit:
const encoded = await encrypt({ email: "alice@example.com" }, resolveKey);
// → base64 string, write to jsonb / TEXT column

// On read:
const payload = await decrypt(encoded, resolveKey);
// → { email: "alice@example.com" }
```

## Wire format

Base64-encoded:

```
[version: 1B][iv: 12B][tag: 16B][ciphertext: NB]
```

`version = 0x01` denotes AES-256-GCM. A future algorithm bumps the byte and gains a new switch arm in `decrypt`. The `iv` is 12 random bytes per encryption (GCM uniqueness contract). The `tag` is the 16-byte GCM auth tag — `decrypt` raises `DecryptionError` on mismatch (wrong key, tampered ciphertext, or corrupt framing).

## Key management is yours

`keyProvider` is called once on first use; the result is cached for the resolver's lifetime. Operators who need rotation construct a new adapter instance with a new provider — the resolver's lifecycle matches the adapter's, not the application's. The package ships no rotation tooling, no KMS integration, no master-key abstraction.

## License

MIT.
