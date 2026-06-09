# ACT-566 — declarative PII: a column, a predicate, a method

For the chapter on regulatory pressure meeting event sourcing. The PII epic landed across #855, #868, #869, #870, #871, and #861. The visible surface is small: one wrapper on the schema, one predicate on the state, one method on the app, one lifecycle event. Behind that surface is the framework's stance on where the boundary between "framework concern" and "operator concern" should sit when GDPR-style erasure meets append-only history.

## The tension that started it

Event sourcing tells the operator that events are facts and facts are immutable. GDPR tells the operator that when a user invokes the right to be forgotten, their personal data must disappear from every system that holds it. Treated naively these two contracts are at war, and the war is usually settled by some flavor of "encrypt the PII and throw away the key" — *crypto-shredding* — which preserves the bytes on disk while making them unreadable. The bytes are still facts; the key is gone; the user is forgotten. Append-only invariant intact.

That story was the wrong one for Act specifically. The framework had already broken the strict append-only invariant in `Act.close()` — close-the-books physically truncates events when a stream is closed, because keeping decades of finalized order history hot was a worse problem than the philosophical purity of never deleting a row. Once that mutation was on the books, the encryption-only story stopped being the only defensible one. If the framework was willing to truncate finalized streams for operational reasons, it could also UPDATE a single column to NULL for compliance reasons. Simpler. Honest about what was already true.

## What shipped

A dedicated column. `events.pii`, `jsonb` on Postgres, `TEXT` on SQLite (JSON-stringified), `Map<event_id, payload>` in `InMemoryStore`. The framework migration adds it on `Store.seed()`. Three pieces of surface, all declarative:

```ts
const TicketOpened = z.object({
  title: z.string(),
  reporterEmail: sensitive(z.string().email()),
});

const Tickets = state("Ticket", schema)
  .emits({ TicketOpened })
  .discloses((event, actor) => actor.role === "support");
```

`sensitive(zodType)` marks which fields route to the side column. `.discloses((event, actor) => boolean)` gates read access. The actor on `LoadTarget` carries identity into reduce, the predicate decides, and the reducer only ever sees the disclosed view — gating happens at the framework layer, not in user code.

Erasure is operator-driven. `app.forget(stream)` delegates to `Store.forget_pii(stream)`, which sets the column to NULL and emits a `forgotten` lifecycle event for telemetry and audit. The Store gains exactly one capability-gated method and one nullable column.

## What the framework deliberately doesn't ship

Encryption at rest is the operator's database-layer concern. `pgcrypto`, RDS TDE, Cloud SQL TDE, SQLite SEE — these exist, they're well-understood, they integrate with the operator's existing key-management story. The framework declines to build a parallel one. There is no `Encryptor` port, no master-key handling, no rotation policy, no application-level cipher. The framework's job is to surface the declaration and route the data; the database's job is at-rest encryption.

This isn't a stub waiting to be filled. The decision is that the operator's existing infrastructure — KMS, TDE, column-level encryption extensions — is the right place for those concerns. An `Encryptor` port may eventually appear as an evidence-gated opt-in for KMS-required deployments, the same gate the framework applies to #854's partitioning opt-ins. It's not on the critical path for compliance-grade erasure.

## The aha

GDPR-style erasure and event sourcing's append-only ideal aren't in tension once you accept that `events` already mutates in `close()`. The framework had already, deliberately, given up on strict append-only for sound operational reasons. The moment that's true out loud, the design that wins is the simplest one that could possibly work: a nullable column, an UPDATE, a predicate. No new ports. No new lifecycle for keys. No ciphertext-on-disk-forever to explain to auditors. An empty cell.

The framework's job is narrow and clearly bounded. It surfaces the declaration (`sensitive`, `.discloses`, `app.forget`), it routes the data to a column the operator can independently manage, it gates reads against the actor, and it emits a lifecycle event when erasure happens. Master-key management, rotation policy, ciphertext at rest, KMS integration — those are not framework concerns. They are operator concerns the operator already knows how to solve with the database layer they already have.

## Connections to other chapters

The shape lines up with the operator-discipline pattern from ACT-723's `app.audit()`: erasure is operator-driven, never auto-invoked, never reachable from a reaction handler. It lines up with the no-helpers-in-core pattern from ACT-602: encryption-at-rest is the database's job, not the framework's, in the same way HTTP delivery lives in `act-http` and not in `@rotorsoft/act`. It lines up with ACT-403's "the convention is the contract" — `sensitive(...)` is the declaration the framework reads to decide which fields take the side route, in the same way `_v<digits>` is the declaration that drives auto-deprecation.

The recurring thread across all of these is the framework's discipline about scope. The job of `@rotorsoft/act` is to express the declaration, route the data, gate the read, and emit the lifecycle. Everything beyond that — encryption strategy, key rotation, audit evidence, regulatory documentation — is somebody else's job, and the framework's contribution is to refuse to make those decisions for them.
