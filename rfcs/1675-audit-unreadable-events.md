# RFC 1675: `unreadable-events` audit category

- **Status:** draft
- **Issue:** #1675
- **Author:** rotorsoft
- **Created:** 2026-09-29

## Motivation

A single `pii` column that will not decrypt aborts every read that touches it. The correlate scan is one of those reads, so one poison row stops **every** stream's reactions — not just the affected stream's — and nothing in the system names the row.

`blocked_streams()` is empty, because nothing is blocked. The error message is deliberately generic about the cause, so an adversarial caller cannot probe which failure mode an input hit, and it named neither the stream nor the id. `app.query_array({})` throws the same way. `app.load(...)` throws, so every subsequent `app.do` on that stream throws too.

`app.audit()` is the tool an operator reaches for when data is corrupt, and its `schema` pass exists precisely to report corrupt events per row. It died on the first unreadable row, before producing a single finding — so the one tool that should locate the problem was the one guaranteed not to.

Triggers are ordinary: bit-rot, a partial restore, a flipped byte, or the documented restart-driven key rotation against any stream whose correlate checkpoint still sits below its pre-rotation events.

## Public surface added

**Public types** — two additions in `libs/act/src/types/audit.ts`:

- `AuditCategory` gains the member `"unreadable-events"`.
- `AuditFinding` gains a variant:

```ts
| {
    category: "unreadable-events";
    stream: string;
    event_id: number;
    reason: "pii_decrypt_failed";
    /** The underlying adapter error, for operators who log it. */
    error: unknown;
  }
```

No new exports, builder methods, port methods, or lifecycle events.

**Adapter-level convention (not a port change).** `@rotorsoft/act-pg` and `@rotorsoft/act-sqlite` now attach `stream` and `event_id` as own properties to the `DecryptionError` they throw, and include both in the message. The error stays `instanceof DecryptionError`, so the two tests that pin that (`pii-encryption.spec.ts`) keep passing unchanged, and `cause` carries the original.

Core reads those two properties **structurally**, never by `instanceof`: `DecryptionError` lives in `@rotorsoft/act-crypto`, and `@rotorsoft/act` does not depend on it. That layering is deliberate and worth more than a nominal check.

## Alternatives considered

**Do nothing.** Rejected. The failure is permanent, silent and app-wide from one row, triggered by the very condition the authenticated envelope exists to detect. An operator has no way to find the row short of reading adapter logs.

**Add a `Store.query` option to skip pii decryption, and use it from the correlate scan.** This is the fix that actually removes the blast radius — the correlate scan only needs `{id, name, stream}` and pays the decrypt for nothing. Rejected *for this RFC*, not on the merits: it changes a charter-covered port, needs TCK cases across InMemory / act-pg / act-sqlite, and is a materially larger change than the locatability half it depends on. Worth its own RFC; the `stream` / `event_id` convention landed here is a prerequisite either way.

**Degrade an unreadable row to a sentinel instead of throwing.** Rejected. `pii-encryption.spec.ts` pins `query()` rejecting with `DecryptionError` for both the wrong-key and tampered-ciphertext cases, and those are the contract. Passing the base64 through as `pii` would be worse than the bug: `pii_gate` treats any non-null `pii` as discloseable and would merge ciphertext into `data`.

**Report it under the existing `schema` category.** Rejected on typing. The `schema` variant requires `name`, and a row that never decrypted never reaches a pass, so its event name is not in hand. Adding a same-discriminant variant without `name`, or making `name` optional, would break consumers that narrow on `category === "schema"` and read `.name` — a breaking change to avoid a new category.

**Put the stream/id in a new error subclass in `act-crypto`.** Rejected. It is more public surface in a leaf package for the same information, and core still could not use it nominally without taking the dependency the layering forbids.

## Stability / charter impact

**Category:** public types.

**Additive.** A new union member on `AuditCategory` and a new variant on `AuditFinding`. Nothing is renamed, removed, or narrowed. Existing consumers that switch on `category` keep compiling; a consumer with an exhaustive switch and no default sees a new case, which is the normal cost of an additive union and is why this RFC exists.

The new category is included in `ALL_CATEGORIES`, so a default `app.audit()` reports these findings without the caller opting in. That is the intended behavior: an operator running a plain audit against a corrupt store should be told.

No port method, so no TCK or adapter matrix work. The adapter-side `stream` / `event_id` convention is documented in each adapter's helper and covered by a test in both `act-pg` and `act-sqlite`.

## Open questions

Whether the `error: unknown` field should be narrowed once the blast-radius RFC lands and more than one adapter condition can produce an unreadable row. Leaving it `unknown` now avoids committing to a shape before there is a second case.
