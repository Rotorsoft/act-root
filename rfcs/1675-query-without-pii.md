# RFC 1675: `Query.with_pii` — let a read decline the sensitive payload

- **Status:** draft
- **Issue:** #1675
- **Author:** rotorsoft
- **Created:** 2026-10-01

## Motivation

Sensitive event fields are stored in a separate `pii` payload, encrypted at rest when the operator configures `pii_encryption`. The adapter decrypts that payload as it materializes each row, before the engine sees it.

If one row's ciphertext is unreadable — a flipped byte, a partial restore, or the documented restart-driven key rotation against a stream whose correlate checkpoint still sits below its pre-rotation events — the decrypt throws and the **entire read** fails. Not that row: the whole query.

The correlate scan is one of those reads. It looks at an event's `name` and `stream` to resolve reaction targets and discards everything else. So a single corrupt row in one stream **stops reactions for every stream in the app**, permanently and silently: nothing is blocked, so `blocked_streams()` is empty, and the scan simply never gets past the poison id. `app.audit()` — the tool an operator would reach for to find corrupt data — dies the same way, on the first bad row, before reporting anything.

The engine cannot currently recover on its own. It never receives the failing row (the adapter dies building it), so it knows only "the read failed somewhere after event N". To skip a row you need its id, and today every way of reading an event also decrypts it.

The fix is to stop asking for data the read is going to throw away.

## Public surface added

Two optional fields, both additive.

**1. `Query.with_pii`** — `libs/act/src/types/schemas.ts`:

```ts
export const QuerySchema = z.object({
  // … existing fields …
  with_pii: z.boolean().optional(),
});
```

surfacing on the inferred `Query` type as `readonly with_pii?: boolean`.

**Contract.** Defaults to `true`, preserving today's behavior exactly. When `false`, the store returns every matching event with `pii` set to `null` and **never decrypts** — so an unreadable payload cannot fail the read.

`null` rather than the raw ciphertext is load-bearing: `pii_gate` treats any non-null `pii` as discloseable and would merge a base64 blob into `data`. A `null` payload is indistinguishable from an event that declares no sensitive fields, which is already a well-defined state throughout the framework.

This is a `Store` contract change, so it lands with `runStoreTck` cases and all three in-tree adapters (InMemory, act-pg, act-sqlite) in the same PR.

**2. `Fetch[number].error`** — `libs/act/src/types/reaction.ts`:

```ts
export type Fetch<TEvents extends Schemas> = Array<{
  // … existing fields …
  readonly error?: string;
}>;
```

Present only when that stream's read failed, and then `events` is empty.

The drain's per-stream reads already ran per stream, but under one `Promise.all` — so one stream's failure rejected the whole cycle and every healthy stream leased beside it got nothing. Containing the failure here keeps the blast radius on the stream that caused it: the cycle records the error, submits no ack (so the watermark holds and the event is not skipped), and the stream accrues `retry` until `blockOnError` quarantines it the usual way, visibly in `blocked_streams()`.

Unlike correlate, this read cannot simply decline the payload — handlers receive it through their own gate, so a fetch that dropped it would hand them a silently incomplete event. Containment is the only option on this path, which is why the two halves of #1675 need different fixes.

No new exports, builder methods, port methods, or lifecycle events.

## Alternatives considered

**Do nothing.** Rejected. One corrupt row stops every stream's reactions, permanently, with nothing naming the row and the diagnostic tool dying on the same error.

**Adapters attach `{stream, event_id}` to the thrown error so the engine can report and skip it.** This was implemented and opened as #1696, then withdrawn in review. It works, and the resilience logic was already entirely in core — but it leaves bespoke decryption error handling duplicated across act-pg and act-sqlite, and it only makes the failure *diagnosable*. The correlate scan still trips, so every stream's reactions still stop. Fixing the blast radius is worth more than naming the row, and this RFC does both.

**Move decryption into the engine behind an `Encryptor` port.** Rejected, and deliberately not reopened: that design was considered and rejected when column encryption was built (#566, alongside inline-ciphertext and sibling-table designs). Encryption stays entirely inside the adapters here. The caller only gains the ability to say it does not need the field.

**Degrade an unreadable row to a sentinel instead of throwing.** Rejected. `pii-encryption.spec.ts` pins `query()` rejecting with `DecryptionError` for both the wrong-key and tampered-ciphertext cases, and those are the contract — a read that asks for pii and cannot produce it must fail loudly.

**Name it `without_pii` / `skip_pii`.** Rejected in favor of `with_pii` for symmetry with the existing `with_snaps`, and because `{ with_pii: false }` reads naturally at the call site. The defaults differ between the two flags (`with_snaps` defaults `false`, `with_pii` defaults `true`), which is a documentation burden the doc-comment carries explicitly; inverting `with_pii` to match would make the common case a double negative and would newly reject today's behavior.

## Stability / charter impact

**Category:** adapter contracts (`Store`) and public types (`Query`).

**Additive.** A new optional field whose absence reproduces current behavior byte for byte. No rename, removal, or narrowed type. Existing adapters that ignore the flag keep compiling and keep passing every pre-existing TCK case; the new cases are what require them to honor it.

**TCK and adapter plan.** `runStoreTck` gains cases pinning that (a) the default still returns the decrypted payload, (b) `with_pii: false` returns `pii: null`, and (c) `with_pii: false` does not decrypt — proven by a corrupt payload that the default read rejects and the flagged read returns cleanly. Run against InMemory, act-pg and act-sqlite.

**One deliberate behavior narrowing, called out for sign-off.** The correlate scan will pass `with_pii: false`, so a *dynamic* reaction resolver (`.to(event => …)`) will see `event.pii === null` where today it would see the decrypted payload. This is typed and reachable today, so it is a semantic change.

It is also a fix. Correlate runs actor-less, so a resolver reading `event.pii` is reading un-gated plaintext with no actor and no disclosure gate — the same defect #1673 corrected on the drain return path and #1277 before it. Nothing in the framework merges `pii` for a resolver, and `data` already lacks the sensitive keys. Treating correlate as a path that never carries plaintext closes that hole on one more surface rather than opening one.

## Open questions

Whether other internal scans that discard `pii` should adopt the flag in this PR or a follow-up. The correlate scan is the one with a proven app-wide blast radius; the close cycle's scans are candidates, but each needs its own check that nothing downstream reads the payload. This PR takes correlate plus the audit's targeted locating read, and leaves the rest for a follow-up that can justify each one individually.
