# ACT-723 — `app.audit()` and the operator's runbook in code form

#723 ships an operator-driven store audit on the orchestrator — nine categories, single-scan multiplexed across the requested set, each finding tagged with the remediation it suggests. Started life as "standalone schema-validation scanner" and reshaped after a design discussion into the IAct-method shape we landed on. Notes for the tooling chapter.

The thread worth pulling on is the operator-discipline pattern that audit completes. Act ships several primitives that look unrelated until you line them up: `app.close()`, `app.reset()`, `app.unblock()`, `app.blocked_streams()`, `app.prioritize()`, and now `app.audit()`. Every one is "operator decides when this runs; framework never auto-invokes." None of them are part of the reaction-handler `IAct` interface — reactions get the narrow surface (`do`, `load`, `query`); operators get the broader one. The split *is* the operator-vs-application boundary.

---

### Threads to develop

**1. Why this isn't a separate package.**
The original ticket framed audit as `@rotorsoft/act-scan` — a standalone tool, not an `IAct` method. The reshape argument is worth telling: packaging is a *distribution* choice, not a *discipline* choice. The fear the standalone package was hedging against was "don't auto-call this expensive thing on `.build()`" — same fear that `app.close()` already navigates without being banished to a separate package. The discipline lives in the *calling pattern* (operator-driven, never on cold start), not in *where the code lives*. The book should generalize this: when you have a discipline ("never auto-invoke"), embed it in the API affordance, not in the package boundary. The operator-driven primitives sit shoulder-to-shoulder on `Act` precisely so the discipline reads as "this category of method behaves like that category."

**2. The category-tagged remediation pattern.**
Each finding shape carries enough context to act directly: stream id, event id, recommendation hint. The category name maps 1:1 to a remediation. That mapping is the audit's whole value-add — without it, you'd just be re-reading the events table with extra steps. The book chapter should call out that *the operator's mental model is the surface*: "what should I do with this store?" → one question, many tagged answers. Different shape from "what's broken?" → a flat error list. Operators don't run audits for diagnosis; they run them for triage.

**3. Single-scan multiplex.**
The first draft had each category running its own `store.query(...)` / `query_stats(...)`. With 9 categories that's 9 table walks on a request for "everything." User feedback nudged the refactor: each category becomes an `AuditPass` factory exposing optional `onEvent` / `onStream` / `onStat` callbacks plus a `finalize` hook for any second-pass work. The dispatcher determines the *union* of needed data sources via `some(p => p.onX !== undefined)`, runs each scan once, and broadcasts to all interested passes. Worst case: three scans total, regardless of categories. Worth dwelling on as a pattern — when the workload is "ask several questions of the same dataset," the abstraction shouldn't be "function per question" but "consumer per question, multiplexed by a coordinator." That generalizes well beyond audit.

**4. The shared discipline of `??` defensive checks.**
Audit code is full of `names ?? {}` and `n ?? 0` and `count ?? 0` fallbacks. They protect against *type-system optionality* that adapters never actually exercise — `query_stats({names: true})` always populates names; values are always numbers. v8 coverage flags these as missed branches because the falsy side of `??` is unreachable in practice. The honest answer is that strict TS types create branches that runtime can't reach. The book might note: when defensive code's only customer is the compiler, the test gap reads as a maturity signal — "this code knows things the type system doesn't." Two responses: c8-ignore the lines (declare them defensive), or strip them and rely on the runtime contract. We chose the former for slice 1.

**5. The categories that DIDN'T make it — store-operator audit.**
Earlier draft of the ticket listed `storage-health` as a category — fragmentation, index bloat, partition rotation, `VACUUM` pressure. We pulled it. Different audience (DBA vs application engineer), different per-adapter (PG ≠ SQLite), different boundary. Act audits what Act knows. Store fragmentation is the store's domain. The book should treat this as the cleanest *no, this belongs elsewhere* moment in the design — and contrast it with what we did keep. `clock-anomalies` is also infra-shaped (clock skew is an SRE problem) but the *detection* costs us nothing once we're already walking events. That's the line: if the audit's existing scan already sees the signal, surface it even if remediation is somewhere else. If it requires *more* knowledge of an adapter, push the work to the adapter.

**6. The audit module's isolation contract.**
`internal/audit.ts` reads through `AuditDeps` only — never reaches into `internal/drain-cycle.ts` or `internal/settle.ts` or any other orchestration internal. The orchestrator builds a typed bag at `.build()` and hands it over via a one-liner. The bag holds *snapshots* of registry state, not live references — so a future orchestration refactor can't accidentally entangle with audit. Same shape as `act-tck` within the workspace: a peer of orchestration that uses its public-ish surface. The book should pull this out as a pattern for *new operator surfaces* — they belong in their own module with a defined deps interface, never sprinkled across the hot-path orchestration files. Operators are slower; orchestration is faster; mixing the two slows both.

**7. The category that taught me the most: `routing-health`.**
The framework's lane mechanic (ACT-1103) is restart-driven: `subscribe()` UPSERTs lane on every call. If you rename a lane in `withLane(...)` and redeploy, existing subscription rows in the streams table still point at the old name. The new app boots, claims, and ... nothing. The streams pinned to `old-lane` never get drained because no controller exists for that lane anymore. `routing-health` surfaces this as `unknown-lane`. The category exists *because* the lane mechanic's restart-driven semantics aren't intuitive at first reading — the audit teaches the operator what the framework requires. There's a broader point here: audit categories double as documentation. An operator who's never read the lane spec but sees an `unknown-lane` finding learns the discipline by remediating once. The framework's invariants become observable through the audit's vocabulary.

---

### Pull-quotes

- "Operator decides when this runs; framework never auto-invokes."
- "When you have a discipline, embed it in the API affordance, not in the package boundary."
- "The operator's mental model is the surface — one question, many tagged answers."
- "Act audits what Act knows."
- "Audit categories double as documentation."
