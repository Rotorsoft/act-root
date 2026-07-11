# RFC 1228: export `pii_fields` for adapter-side sensitivity introspection

- **Status:** accepted
- **Issue:** #1228
- **Author:** Claude Fable 5
- **Created:** 2026-07-11

## Motivation

`sensitive(z.string())` marks a schema field out-of-band, in a process-global
`WeakMap` the framework consults on commit, load, and handler dispatch. That
registry is unreachable from outside `@rotorsoft/act` — the marker is intentionally
not carried on the Zod type. So an adapter that emits its own view of an action's
input schema has no way to know which fields the domain author flagged as PII.

The `@rotorsoft/act-http/openapi` emitter is exactly that adapter. It walks
`z.toJSONSchema(action_input)` and publishes the result as the request-body schema.
Today, an action input `email: sensitive(z.string())` lands in the public OpenAPI
document with no marking at all — codegen tools, Swagger UI's "Try It" panel, and
request logs treat it as an ordinary string and echo it freely (#1228). The emitter
needs the same field list the orchestrator already computes, and the only correct
source is the framework's own registry lookup.

## Public surface added

- **Export** — `pii_fields(schema: z.ZodType): readonly string[]` from
  `@rotorsoft/act`. Pure, read-only. Returns the top-level object keys marked via
  `sensitive(...)`; `[]` for non-object schemas or objects with no sensitive
  fields. The function already exists internally (`libs/act/src/internal/sensitive.ts`)
  and is used by the state builder — this RFC only surfaces it, re-exported next to
  the existing public `sensitive` / `REDACTED` / `SHREDDED` from the same module.

No new types, builder methods, port methods, or lifecycle events.

## Alternatives considered

- **Reimplement the walk in act-http.** Rejected: the sensitivity marker lives in a
  `WeakMap` private to `@rotorsoft/act`. An external reimplementation cannot read it,
  so it would have to guess (e.g. a naming convention) — brittle and divergent from
  the orchestrator's own view. The whole point is that the emitter and the commit
  path agree on which fields are sensitive.
- **Add a narrow `@rotorsoft/act/internal` subpath** exposing the internal barrel.
  Rejected: the stability snapshot inlines every entry point's transitive source, so
  a subpath over the internal barrel would snapshot the entire orchestrator under a
  new key — large, fragile, and it would surface far more than one read-only helper.
- **Do nothing.** Rejected: the response side is already clean (fixed generic
  `SnapshotArray`), but request-side PII fields ship unmarked in a document meant for
  public codegen. Low severity (client-supplied data), but a real gap the doc
  otherwise silently misrepresents.

## Stability / charter impact

- Category: **public types / exports** (STABILITY.md). Purely **additive** — one new
  read-only function next to existing sensitive-data exports. No rename, removal,
  narrowing, or semantic change.
- No port method, so no TCK/adapter matrix work. The claim (`pii_fields` returns the
  sensitive top-level fields, and the openapi emitter marks them `writeOnly` +
  `format: password`) is pinned by a unit test in
  `libs/act-http/test/openapi/index.spec.ts`.

## Open questions

None.
