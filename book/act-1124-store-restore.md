# ACT-1124 — `Store.restore` and the costs of taking the legacy path seriously

ACT-1124 promoted `restore` from inspector-private raw SQL to a port method on `Store`. The change is small in code — a new optional method, a TCK case, three adapter implementations — but the design walked through more wrong turns than the LOC suggests, almost entirely because the legacy raw-SQL behavior was both load-bearing and quietly weird. Capturing the rejected paths here because they each name a separate rule about port design that's easy to lose once the diff is merged.

---

**The pain that started it.**

The inspector's `restore` procedure was the only piece of the codebase that bypassed the `Store` interface — it opened a raw `pg.Client`, ran `TRUNCATE … RESTART IDENTITY` + `INSERT` in a single transaction, and called it done. PG-only by construction. When ACT-1122 generalized the inspector's discovery layer to scan SQLite files too, that raw-SQL chunk became the one thing standing between the inspector and adapter symmetry. Every Group 3 ticket in the saga (inspector restore rewrite, UI, cross-adapter migration) depended on lifting restore onto the `Store` port.

The pattern under it: a destructive operation that wipes everything and rebuilds, atomically, from a source. Not `commit` (which sequences new events and stamps `now()`); not `truncate` (which seeds a single stream with a tombstone); something else. The framework had no primitive for it, and the inspector's raw-SQL workaround was, on closer reading, doing three things that needed to be true *together* for the operation to make sense.

---

**The first wrong turn: passive defaults on every option.**

The drafted ticket leaned forward — `RestoreOptions` would ship in v1 with `dropClosedStreams`, `dropSnapshots`, `dropEmptyStreams`, `dryRun`, `onProgress`, plus a migration overlay (`eventNameMap`, `transform`, `streamRename`). The compaction toggles were obvious follow-on use cases; might as well land them now while the design is fresh.

That collapsed under a different test: each flag was a separate design problem. `dryRun` is the cleanest example. In a "compaction filter" framing, `dryRun: true` means "tell me which rows would be dropped." In an "import validator" framing, it means "scan the source and report blockers — version-contiguity gaps, broken causation refs, duplicate ids, malformed timestamps — without writing." Same surface, two different semantics. Shipping the boolean without picking the semantic would lock the wrong one in by accident.

The teachable thing: when a placeholder field has multiple defensible meanings, omitting it costs nothing and naming it costs a future design discussion. v1 of `RestoreOptions` is `{ _reserved?: never }`. The follow-on tickets (#784 for compaction toggles, #785 for the migration overlay) own the semantic, and they get to make that choice with fresh context.

---

**The second wrong turn: required-on-`Store`.**

The early draft made `restore` a required method on `Store`. Reasoning: every in-tree adapter (InMemory, PG, SQLite) ships it, callers should be able to rely on it always existing, no capability gate to maintain.

What that misses: `Store` is an open contract. The framework's no-third-party-adapters status is a fact about today, not a constraint on the future. A Redis-backed event log, a Kafka-fronted store, a partitioned multi-shard adapter — none of those can atomically wipe-and-rebuild in a single transaction. Making `restore` required would either lock those adapters out of `Store` or force them to ship a `restore` that throws, which is worse than not having the method.

The pattern Act already had — `Store.notify` is optional, gated behind a `Capabilities.notify` flag in the TCK — was the right precedent. `restore?:` joins it: an opt-in surface that the TCK exercises against adapters that declare the capability, and that callers must guard. The cost is one `if (store.restore)` at every caller site; the benefit is a contract that future adapters can fit themselves into.

---

**The third wrong turn: renumbering ids in isolation.**

The legacy inspector restore renumbered ids via PG's `RESTART IDENTITY` — the source's original id column was thrown away, and the rebuilt store assigned fresh dense ids from 1. Carrying that forward as "id is renumbered, source ids are ignored" felt safe.

It wasn't. Act event metadata carries causation references — when reaction R commits event E in response to triggering event T, E's `meta.causation.event.id` is T's id. If restore renumbers ids without touching meta, every causation chain that the source committed becomes a set of broken pointers. The references would still parse (id is just a number), but they'd point at the WRONG events post-restore, or at no event at all.

The fix is structural: `RestoreRow` carries the *original* `id` as a lookup key. Adapters build a per-call `old → new` map as rows land, and rewrite `meta.causation.event.id` before writing. Refs to ids not in the source (partial backups) pass through unchanged. The original id is never persisted — adapters drop it on insert and let the SERIAL / AUTOINCREMENT sequence assign fresh — but it's load-bearing during the call.

The teachable thing: when a port's documented behavior is "X stays the same, Y changes," check every cross-reference between X and Y. The inspector's raw SQL had this bug for as long as it existed; nobody noticed because the inspector's restore was used almost exclusively to round-trip a backup whose ids would line up after renumber. The first time someone restored a backup with sparse ids (compaction, partial export) the causation chain would have silently broken. Worth catching at the port level, not the callsite.

---

**The fourth wrong turn: making it observable.**

The early sketch added an `Act.restore(source, opts)` wrapper on `IAct` plus a `"restored"` lifecycle event — symmetry with `committed` / `closed` / `notified`. Operators running an SSE-driven dashboard could see the rebuild happen in real time; audit logs could capture it without a separate inspector procedure.

That has a real cost: every method on `IAct` is charter-covered surface, and every name in `ActLifecycleEvents` is too. Adding both for a primitive that's called once an incident, with the result already captured by the inspector's audit log via the procedure's return value, is bad scope discipline. The two additions buy zero observability that the inspector audit log doesn't already have. They cost a charter slot each, and they invite future tickets to expand the wrapper (`Act.restore` becomes the natural home for the compaction flags, but compaction is a port-level concern, not an orchestrator concern…).

Deferred. The `RestoreResult` returned by the port carries `kept` + `duration_ms` + the placeholder `dropped` + `dry_run` fields; callers log what they want. If cross-process observability becomes a real ask, the lifecycle event lands then — additive, no breakage.

---

**The thing that shipped.**

`Store.restore?: (source: AsyncIterable<RestoreRow>, opts?: RestoreOptions) => Promise<RestoreResult>`. Capability-gated. AsyncIterable source so multi-million-row backups don't OOM the server. Atomic per call (PG `BEGIN`/`COMMIT`, SQLite `BEGIN IMMEDIATE`, InMemory snapshot-and-swap). `created` preserved verbatim. `id` renumbered. Causation refs rewritten through the per-call `old → new` map. The TCK has ten test cases — empty source, single stream, multi-stream, ISO `created`, pre-existing wipe, subscription clearing, snapshot preservation, causation remap, orphan-ref pass-through, atomic rollback on mid-iteration throw — and every in-tree adapter passes them.

The book-note convention is that the essay tries to leave one mental model behind, not three. For this one: **legacy raw-SQL paths are dangerous to lift verbatim, because the things they happen to do by accident become part of the contract once they're on the port.** The renumber-without-causation-remap bug existed in the inspector for as long as the inspector did; nobody had complained because nobody had stressed it. Promoting it to a port method without auditing what the SQL was implicitly doing would have shipped the bug forever.

---

**Parked directions.**

- **Compaction toggles** (#784): `dropClosedStreams`, `dropSnapshots`, `dropEmptyStreams`, `dryRun` (as the blocker-scan variant), `onProgress`. The v1 result shape already carries the `dropped` counters and `dry_run` flag as placeholders so #784 is purely additive.
- **Migration overlay** (#785): `eventNameMap`, `transform`, `streamRename`. The lifeless-source rebuild becomes a schema-migration primitive.
- **Online close-the-books** (#802 / ACT-1132): restore is the offline wipe-and-rebuild; close is the per-stream-truncate counterpart, and today only the operator-driven variant exists. A policy-driven online variant — `closeWhen(predicate)` on the builder, running on a cycle alongside drain — is its natural sibling. Filed as a future-direction placeholder.
- **Lifecycle event**: `"restored"` on `Act` if cross-process observability earns it. Likely paired with `Act.restore()` wrapper for surface symmetry.
