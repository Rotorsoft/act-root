# RFC 1277: prebuilt per-event read gate (`registry.query_gate`) and gate consolidation

- **Status:** accepted
- **Issue:** #1277
- **Author:** Claude Opus 4.8
- **Created:** 2026-07-18

## Motivation

`sensitive(...)`-marked fields are isolated into a separate `pii` column on
commit and only merged back on an authorized read. The disclosure gate
(`pii_gate`) lived on the `load` / `do`-return path, but `IAct.query` and
`IAct.query_array` handed store events straight to the caller with no gate at
all — the isolated `pii` sidecar rode along verbatim, worst on Postgres, which
decrypts at-rest ciphertext before returning it. That is the #1277 leak.

The obvious fix — run every queried event through
`pii_gate(e, registry.sensitive_fields(e.name), null, undefined)` — closes the
leak but pays a per-event `Map` lookup **plus** a fresh `?? []` allocation on
**every** event, in **every** query, including apps that declare zero sensitive
fields. The same pattern already sat on the load path: `state.view` did
`pii_gate(event, fields_by_event.get(name) ?? [], disclose, actor)` per folded
event. The gating cost was being paid by events that carry no PII.

The framework already knows, at build time, exactly which events are sensitive.
The gate should be **prebuilt per event** so non-sensitive events cost nothing
and the sensitive-field lookup is never recomputed on a hot read.

## Public surface added

- **`Registry.query_gate: (event_name: string) => (event) => event`** — returns
  a prebuilt read gate for the actor-less read surfaces. A non-sensitive event
  resolves to a single shared identity gate (the event is handed back
  untouched, zero allocation); a sensitive event resolves to a redactor built
  once at build time that closes over the field list and applies default-deny
  (`[REDACTED]`, or `[SHREDDED]` once the pii column is forgotten) while
  dropping the isolated `pii` sidecar. Symmetric with the existing
  `sensitive_fields` / `disclosure_predicate` / `deprecated_events` registry
  introspection members.

No new builder methods, port methods, lifecycle events, or top-level exports.
`EventGate` / `IDENTITY_GATE` / `make_gate` are `@internal` (in
`libs/act/src/internal/sensitive.ts`), reachable only through the barrel used by
the builder — not re-exported from the package root.

## Design — one prebuilt gate primitive for every read surface

`make_gate(fields, predicate)` returns a closure `(event, actor?) =>
pii_gate(event, fields, predicate, actor)`. The builder prebuilds gates once,
in the pass that already computes `_sf` (sensitive fields per event):

- **Query path** — `_qg.set(name, make_gate(fields, null))` for each sensitive
  event. `registry.query_gate(name)` returns that gate, or the shared
  `IDENTITY_GATE` for everything else. `query` / `query_array` call
  `registry.query_gate(e.name)(e)` — no actor, predicate-less → default-deny,
  mirroring a bare-string `load`.
- **Load path** — each pii-aware state prebuilds one `make_gate(fields,
  state.disclose)` per sensitive event into a per-state map; `state.view` falls
  back to `IDENTITY_GATE` for the state's non-sensitive events. This replaces
  the per-event `fields_by_event.get(name) ?? []` + unconditional `pii_gate`
  call.

Because `make_gate` is only ever invoked for sensitive events (non-sensitive
events short-circuit to `IDENTITY_GATE` before reaching it), `pii_gate`'s old
`if (fields.length === 0) return event` guard became dead code and was removed —
non-empty `fields` is now a documented precondition, matching `pii_strip`.

There is no actor-authorized query path: a handler needing plaintext reads
through `load(stream, { actor })`, where the security-relevant call is visible
in code review. Adding an actor to the query bag would be net-new surface and is
deferred.

## Alternatives considered

- **Per-event `sensitive_fields` lookup in `query` (the first #1277 fix).**
  Rejected: recomputes the lookup and allocates `?? []` for every event in
  every query, penalizing the overwhelmingly common non-PII app. The whole
  objection that drove this RFC.
- **A `sensitive_events: ReadonlySet<string>` on the registry + membership
  check.** Rejected in favor of the prebuilt gate: a set answers "is this event
  sensitive" but still forces the caller to branch and re-derive the redactor;
  the prebuilt closure captures the fields once and unifies query and load on
  one primitive.
- **Gate inside each Store adapter.** Rejected: the store is contractually
  correct to return the raw `pii` column; the disclosure policy is orchestrator
  concern. Gating in three adapters triples the surface and the divergence risk.

## Stability / charter impact

- Category: **public types** (STABILITY.md). Purely **additive** — one new
  read-only member on `Registry`, alongside the existing sensitive-data
  introspection family. No rename, removal, narrowing, or semantic change to any
  existing member.
- `query` / `query_array` now redact sensitive fields by default where they
  previously leaked plaintext. This is a **security fix**, not a break: no caller
  should rely on leaked PII, and non-sensitive apps are byte-for-byte unaffected
  (identity gate). Flagged in the PR body.
- No port method, so no TCK/adapter matrix work. The claims (query default-deny
  redaction; the sidecar never rides a gated read; non-sensitive passthrough)
  are pinned by `libs/act/test/read-gate.spec.ts` and the
  behavior-contract checklist row for the query gate.

## Open questions

None.
