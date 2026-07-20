# ACT-1294 — the introspection surface that leaked PII on one adapter

`query_stats` is the operator-facing primitive: give it a set of streams and it hands back the head event, optionally the tail, a count, and a name histogram. Dashboards call it. Schema tooling calls it. The close cycle calls it. None of them carry an actor, because none of them are answering a user's question about their own data — they are answering an operator's question about the shape of the store.

That is exactly why it became a quiet disclosure hole. When #921 added envelope encryption to the SQLite adapter, the `pii` column was wired through every read path uniformly, `query_stats` included. So `query_stats` head/tail on SQLite came back with the pii sidecar decrypted to plaintext — `{ email: "user@example.com" }` sitting in the same object a dashboard renders. PostgresStore never selected the column in its `query_stats` path, and InMemory keeps pii in a separate map it doesn't merge there, so both of them returned head/tail with no pii at all. Three adapters, two answers, and the disclosure lived on the one an operator is most likely to point at a Grafana panel.

The pain that surfaced it was not a crash. Everything was green. A hunter noticed that the same commit-then-`query_stats` sequence returned a different shape on SQLite than on PG, and that the difference happened to be a plaintext email. The store-TCK never pinned the behavior either way, so the adapters had drifted without anything failing.

---

**The wrong turn: make the leak consistent instead of closing it.**

The obvious symmetry fix is to make all three adapters agree by *carrying* pii everywhere — teach PG and InMemory to surface it too, and you have parity. It's tempting because it's additive and it makes the differential TCK go quiet.

It's also the wrong direction, and #1277 had already established why. `query`/`query_array` used to hand committed events straight to the caller with no disclosure gate, and the fix there was not "gate `query_stats` too" — it was default-deny: a read with no actor context surfaces no pii. `query_stats` has *no place to put an actor*. Its whole job is aggregate operator introspection, not per-subject data access. Adding a gate would be inventing an authorization dimension for a surface that has never had one, to protect data the surface has no reason to return. The right move is the boring one: the introspection surface simply doesn't carry pii, on any adapter. If you want a subject's pii, you go through `load`, which is gated.

So the fix strips the pii column from SQLite's two `query_stats` SELECTs and drops the decrypt call from both `to_committed` closures, matching what PG and InMemory already did. The pii stays durably encrypted on disk; the difference is that this surface stops surfacing it. `load` and gated `query` still round-trip it exactly as before.

---

**Pinning it so the drift can't recur.**

The deeper failure was not the leak, it was that nothing executable said which behavior was correct. Two adapters did one thing, one did another, and the TCK — the executable cross-adapter contract — was silent on pii-in-`query_stats` entirely. A parity fix that only edited SQLite would leave the same gap open for the next adapter someone writes.

So the fix lands with a store-TCK case gated on the `pii_isolation` capability: commit two events carrying pii, call `query_stats` down both code paths (heads-only and the full-scan that count/names trigger), and assert head and tail carry no pii. It runs against every pii-capable adapter, so PG and SQLite both prove it now and any future adapter inherits the assertion for free. The claim also earns a row in the behavior-contract checklist and a sentence in the `StreamStats` doc-comment, because a runtime guarantee with no test behind it is how #1294 happened in the first place.

The rule worth keeping: an introspection surface with no actor is a surface with no business returning per-subject secrets, and "the adapters happen to agree today" is not a contract — the TCK is.

See `libs/act-sqlite/src/sqlite-store.ts` (`_query_stats_heads_only` / `_query_stats_full_scan`), `libs/act-tck/src/store-tck.ts` (the `pii_isolation` block), and [#1294](https://github.com/Rotorsoft/act-root/issues/1294).
