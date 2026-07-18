---
id: sensitive-data
title: Handling sensitive data
description: Isolating, redacting, and irreversibly forgetting PII in an Act event store.
sidebar_position: 2.5
---

# Handling sensitive data

The event log is append-only. That's the property that makes event sourcing work — and it's also what makes "delete the user's email when they ask us to" awkward. You can't `UPDATE events SET data = ...` without breaking the contract every reducer and projection depends on.

Act's answer is to keep the sensitive bits out of `events.data` in the first place. The framework splits PII off into a separate column at commit time, gates reads through an actor-aware disclosure predicate, and gives operators a single `app.forget(stream)` call that wipes that column in place — leaving the rest of the row, including every causation reference, structurally intact.

This guide walks through the declarative surface, the read-path semantics, the erasure recipe, and the boundaries the framework deliberately does not cross.

## What this guide answers

- When do I need `sensitive()` and what does it actually change about commit / load?
- How do I make sure operators can forget user data on request?
- What does the framework redact for me, and what's still my job?
- Where does encryption belong?

## The declarative surface — `sensitive(...)`

Marking a Zod schema field with `sensitive(...)` is a pure annotation. The static type of the schema is unchanged; the function returns the same schema instance after registering a marker the orchestrator inspects at build time.

```ts no-check
import { z } from "zod";
import { sensitive, state } from "@rotorsoft/act";

const UserRegistered = z.object({
  email: sensitive(z.string().email()),
  name: sensitive(z.string()),
  plan: z.enum(["free", "pro"]), // not sensitive — stays in events.data
});

export const User = state({ User: UserSchema })
  .init(() => ({ id: "", plan: "free" }))
  .emits({ UserRegistered })
  .patch({
    UserRegistered: (event, state) => ({
      ...state,
      id: event.stream,
      plan: event.data.plan,
    }),
  })
  .on({ register: registerSchema })
  .emit((payload, _snapshot, target) => [
    "UserRegistered",
    {
      email: payload.email,
      name: payload.name,
      plan: payload.plan,
    },
  ])
  .discloses((event, actor) => actor.id === event.stream || actor.role === "admin")
  .build();
```

At commit time the framework splits the emitted event by the marked keys. The shape that goes to the store is:

```jsonc
// events.data
{ "plan": "pro" }
// events.pii  (separate column)
{ "email": "alice@example.com", "name": "Alice" }
```

Both columns live in the same row, in the same transaction. The non-sensitive payload stays where reducers and projections expect it; the sensitive payload lives in a column the rest of the system never depends on for derivation. Adapters that declare the `pii_isolation` capability — every in-tree adapter does (InMemoryStore, PostgresStore, SqliteStore) — persist the split. Adapters that don't ignore the field and surface a build-time error the moment you call `app.forget(...)`, so the misconfiguration shows up in dev rather than during a compliance audit.

Schema-evolution rules still apply. The reducer for `UserRegistered` continues to see the merged event shape after replay; the split is invisible to it. When a sensitive field's type changes, version the event the same way you would any other breaking change (`UserRegistered_v2`) — see [event schema evolution](../architecture/event-schema-evolution.md).

One build-time constraint to know: a state whose events declare any `sensitive(...)` field cannot also declare `.snap()`. Snapshots write derived state into `__snapshot__.data`, which `forget_pii` can't reach. Building an Act with that combination throws with a clear message — the misconfiguration is surfaced in dev, not silently months later. PII-aware states also bypass the snapshot cache by design; see [Cache contract on PII-aware states](#cache-contract-on-pii-aware-states) below.

## Reading sensitive events — the auth-aware load

`IAct.load` has two shapes that differ only in how they answer the question "is this caller allowed to see the plaintext?"

The bare-stream form is default-deny. The caller has no authorization context, so every sensitive field comes back as `"[REDACTED]"`:

```ts no-check
const snap = await app.load(User, "user-42");
// snap.event.data.email === "[REDACTED]"
// snap.event.data.name  === "[REDACTED]"
// snap.event.data.plan  === "pro"
```

Use this in background workers, observability probes, replay scripts — anywhere the call has no actor and no business seeing the plaintext.

The auth-aware form takes a `LoadTarget` carrying the actor, and runs the state's `.discloses(predicate)` against it:

```ts no-check
const snap = await app.load(User, {
  stream: "user-42",
  actor: { id: "user-42", name: "Alice", role: "user" },
});
// Predicate returned true (actor owns the stream) → plaintext.
// snap.event.data.email === "alice@example.com"
// snap.event.data.name  === "Alice"
```

When the predicate returns `false` — wrong tenant, wrong role, anonymous read — sensitive fields come back as `"[REDACTED]"` exactly as in the anonymous case. There is no third "raw" mode. A state with no `.discloses(...)` declaration default-denies on every external read, which is the fail-safe stance: forgetting to declare the predicate cannot accidentally expose data.

Every gated read drops the isolated `pii` sidecar from the returned event — `load` included. Plaintext survives only inside `event.data`, and only on the authorized path; it never rides in a raw `event.pii` field to a caller. The raw event-query surfaces — `app.query(...)` and `app.query_array(...)` — carry no authorization context, so they **default-deny** exactly like a bare-stream `load`: every declared sensitive field comes back `"[REDACTED]"` (or `"[SHREDDED]"` once forgotten). The store returns the raw column faithfully; the gate lives in the orchestrator. There is no actor-authorized query — a handler that genuinely needs plaintext reads through `app.load(stream, { actor })`, where the disclosure predicate can run.

The same gating applies to reducers and projections in PII-aware states: the reducer chain runs against the actor-gated view, so derived `state` reflects only what the calling actor is allowed to see. Reaction handlers and projection handlers, by contrast, never see the sensitive keys at all — the framework strips them before invoking the handler, so a misconfigured projection writing `event.data.email` into a column gets `undefined`, not a sentinel string that looks like real data. The strictness is deliberate.

When a reaction genuinely needs PII (e.g. a welcome-email handler that has to read the address), opt back in explicitly by calling `app.load(stream, { actor: systemActor })` inside the handler. Pulling PII through the gate at the call site makes the security-relevant path visible in code review.

## Forgetting — `app.forget(stream)`

When a user requests deletion, you don't rewrite history. You wipe the PII column for every event on their stream, leaving the rest of the event log intact:

```ts no-check
const { eventCount } = await app.forget("user-42");
// eventCount === 7 (all events on the stream had their pii column nulled)
```

The call is irreversible. After it returns, the row's `pii` column is `NULL`. Subsequent loads — even by an authorized actor — return `"[SHREDDED]"` for every sensitive field on those events, because the framework can tell the column was wiped versus merely redacted:

```ts no-check
const snap = await app.load(User, {
  stream: "user-42",
  actor: adminActor, // .discloses returns true
});
// snap.event.data.email === "[SHREDDED]"  (data is gone, no auth question)
// snap.event.data.name  === "[SHREDDED]"
// snap.event.data.plan  === "pro"          (non-sensitive untouched)
```

`forget` is idempotent. Calling it twice on the same stream returns `eventCount: 0` on the second call and does not re-emit the lifecycle event. The append-only invariant on `events.data` is preserved — only the separately-isolated PII column is mutated.

The framework's `forget` flow does three things in order: it delegates to the store's `forget_pii(stream)` capability, invalidates the cache entry for the stream (so the next load reflects the wipe), and emits a `forgotten` lifecycle event with `{ stream, at, eventCount }`. The lifecycle event is your hook for compliance bookkeeping:

```ts no-check
app.on("forgotten", async ({ stream, at, eventCount }) => {
  await auditLog.write({
    kind: "pii_forgotten",
    stream,
    at,
    eventCount,
    requestId: currentRequestId(),
  });
  // Cascade to any external read models the framework doesn't reach.
  await searchIndex.deleteByStream(stream);
  await analyticsStore.purgeStream(stream);
});
```

A typical GDPR-erasure recipe looks like this:

```ts no-check
async function handleErasureRequest(userId: string) {
  // 1. Wipe the PII column on the user's event stream.
  const { eventCount } = await app.forget(`user-${userId}`);

  // 2. Cascade to projection tables the framework doesn't own.
  await db.delete(userProfiles).where(eq(userProfiles.id, userId));
  await db.delete(userSessions).where(eq(userSessions.userId, userId));

  // 3. Record the compliance event (the `forgotten` listener above does
  //    this too — pick one source of truth).
  await complianceLog.record({ userId, eventCount, at: new Date() });
}
```

Disk reclamation is adapter-dependent. PostgreSQL's autovacuum reclaims the freed space lazily; SQLite needs a `PRAGMA incremental_vacuum` or `VACUUM` to release pages back to the OS. For strict-deletion jurisdictions, the [production checklist](./production-checklist.md) covers the operator step.

## What the framework does NOT do

The boundaries matter as much as the surface. The framework owns isolation and erasure of the PII column. It does **not**:

- **Ship encryption at rest.** Encryption-at-rest is the operator's database-layer concern (pgcrypto, RDS / Cloud SQL TDE, SQLite SEE, encrypted filesystems). It applies uniformly to `events.data` and `events.pii` because both live in the same row. For an application-layer encryption pattern that complements `sensitive(...)`, see the sibling guide on [PII encryption at rest](./pii-encryption-at-rest.md).
- **Manage keys.** No key derivation, no envelope encryption, no KMS integration. If you need per-tenant or per-user keys, that lives in your application's crypto layer on top of the `sensitive()` declarations.
- **Cascade `forget` to projections.** `app.forget(stream)` wipes the event store's PII column. Projection tables, search indexes, analytics pipelines, third-party CRMs, and warm caches outside the framework are the operator's responsibility. The `forgotten` lifecycle event is the hook to wire those cascades onto.
- **Cascade `forget` to external systems already delivered.** A webhook fired on `UserRegistered` carrying the plaintext email is now downstream — `forget` cannot recall it. If a receiver needs to participate in erasure, send them a follow-up "forget this user" event rather than expecting the framework to reach across the network.

## Cache contract on PII-aware states

States whose events declare any `sensitive(...)` field never populate the snapshot cache. The reason is structural: state in a PII-aware reducer chain derives from the **actor-gated event view**, so the cached state would vary by caller. Caching a snapshot produced for an admin actor and serving it to a regular user would leak plaintext past the disclosure predicate, and there's no safe per-caller key that doesn't reintroduce the same problem at the cache layer.

Pure states (no sensitive markers anywhere in their event union) cache normally — the snapshot is purely derived from `events.data` and is identical for every caller. The cache split is transparent: `state.pii_aware` is `true` when the state's events declare any sensitive fields, and the load path consults it on every read.

This is a deliberate performance trade-off rather than a bug. PII-aware states pay the full replay cost on every load; pure states keep the existing fast path. If your hot read path is on a PII-aware state, profile it — a state mostly serving authenticated reads on long streams may benefit from being split into a small sensitive state plus a larger pure projection that the cache can cover.

## Pointers

- `libs/act/src/types/schemas.ts` — `sensitive(zodType)` public marker; `REDACTED` / `SHREDDED` sentinels
- `libs/act/src/internal/sensitive.ts` — `pii_fields`, `pii_split`, `pii_gate`, `pii_strip` helpers the orchestrator calls
- `libs/act/src/builders/state-builder.ts` — `.discloses(predicate)` builder method
- `libs/act/src/builders/act-builder.ts` — three-pass PII wiring (events / states / batch handlers) at build time
- `libs/act/src/act.ts` — `forget(stream)` orchestrator method and `forgotten` lifecycle event
- `libs/act/src/types/action.ts` — `IAct.load` overloads, `LoadTarget`, `Snapshot`
- `libs/act/src/types/ports.ts` — `Store.forget_pii(stream)` and the `Message.pii` field
- `libs/act-tck/src/store-tck.ts` — the `pii_isolation` capability suite every adapter is validated against
- [Architecture → Extension points § Store contract](../architecture/extension-points.md#store-contract) — the `forget_pii` method and `pii_isolation` capability gate
- [PII encryption at rest](./pii-encryption-at-rest.md) — operator-side encryption recipes that complement `sensitive(...)`
