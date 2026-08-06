# RFC 1380: `dateReviver` — one shared JSON date reviver

- **Status:** draft
- **Issue:** #1370 (and #1365)
- **Author:** Rotorsoft
- **Created:** 2026-08-05

## Motivation

JSON has no date type, so a `Date` committed into an event's `data`, `meta`, or `pii` serializes to an ISO-8601 string. Reading it back as a string silently breaks reducers that call `.getTime()`, so every adapter revives dates on read — a cross-adapter parity contract settled in #1198 and enforced by the store TCK's Date round-trip cases.

Until now each adapter carried its own copy: `act-pg/src/utils.ts` and `act-sqlite/src/sqlite-store.ts` held byte-identical ISO-8601 regexes and reviver functions, the SQLite one commented "Parity with PG's JSONB reviver (#1198)". Two hand-synced copies of a rule that must not diverge.

It did diverge. #1365 found SQLite's sensitive-column read using a bare `JSON.parse` while `data`/`meta` went through the reviving helper two lines away; #1370 found the same gap on both adapters' encrypted path, where `act-crypto` parses the decrypted plaintext itself. Three of four `{PG, SQLite} × {plaintext, encrypted}` cells returned a `Date` as a `string`. The fix requires every adapter to apply the reviver to *every* JSON column including decrypted `pii` — which is a rule about a shared definition, and a shared definition is what was missing.

Third-party adapters have the same need: passing the store TCK requires this exact behavior, and today the only way to get it is to reinvent the regex.

## Public surface added

- **Export** — `dateReviver` from `@rotorsoft/act`:

  ```ts
  export const dateReviver: (_key: string, value: unknown) => unknown;
  ```

  Returns a `Date` when `value` is an ISO-8601 string, otherwise `value` unchanged. Shaped for direct use as the second argument to `JSON.parse`.

Naming: camelCase, matching the public-surface convention (and the name act-pg already used internally). The backing `ISO_8601` regex stays module-private.

No new builder methods, port methods, lifecycle events, or public types.

## Alternatives considered

- **Do nothing — keep two copies.** The status quo, and a real option since both copies happen to be identical *today*. Rejected because the bug being fixed is precisely a divergence between parse paths; leaving two definitions in place while adding a third consumer (the decrypt path) invites the next drift. It also leaves third-party adapters reinventing the regex to pass the TCK.
- **Bake the reviver into `@rotorsoft/act-crypto`'s `decrypt`.** No new surface anywhere, one line. Rejected: that package deliberately makes no policy about payload semantics, non-Act consumers storing timestamp-shaped strings would suddenly get `Date`s, and it would create a *third* implementation to keep in sync — curing a divergence bug by adding a divergence.
- **Have act-sqlite import from act-pg.** One copy, no new core surface. Rejected outright: adapters must not depend on each other.
- **Keep it internal to core and re-export privately to adapters.** No mechanism exists for that — adapters consume `@rotorsoft/act`'s public entry. Making it public is also the honest outcome, since third-party adapters need it.
- **Widen `act-pg`'s existing `dateReviver` and pass it around.** What the first draft of #1380 did. Rejected on review: it preserved the duplication and changed a signature purely to satisfy a parameter type introduced in the same PR.

## Stability / charter impact

- **Category:** public types / exports (`libs/act/src/index.ts` via `utils.ts`).
- **Additive.** A new export; nothing renamed, removed, or narrowed. `act-pg`'s copy was never in its public entry (`index.ts` re-exports only `postgres-store.js`), so deleting it is not a breaking change for consumers.
- **Not a port method** — no TCK capability flag needed. The store TCK already asserts Date round-trips (now including `pii`, plaintext and encrypted), so every in-tree adapter is held to the shared definition by tests that already exist.

## Open questions

None. One follow-on worth noting for reviewers: `@rotorsoft/act-crypto`'s `decrypt` gains an **optional** reviver parameter in the same PR so adapters can thread this through the encrypted path. That is additive to a leaf package and does not itself introduce a new export.
