# RFC NNNN: <short title>

- **Status:** draft <!-- draft | accepted | rejected | superseded -->
- **Issue:** #NNNN
- **Author:** <name>
- **Created:** YYYY-MM-DD

> Copy this file to `rfcs/NNNN-<slug>.md` (use the PR number, or the issue number
> if you open the RFC first) and fill in every section. Keep it short — an RFC is a
> design note, not a spec. If a section doesn't apply, say so in one line rather
> than deleting it.

## Motivation

What problem does this solve? Who hits it, and how do they work around it today?
Lead with the user-facing need, not the implementation. One or two paragraphs.

## Public surface added

Enumerate every new entry on the public surface this introduces — the things
[STABILITY.md](../STABILITY.md) will then protect:

- **Exports** — new `import { … }` from `@rotorsoft/act` (or any `@rotorsoft/act-*` entry point / subpath).
- **Builder methods** — new fluent methods on `state` / `slice` / `projection` / `act`.
- **Port methods** — new methods on `Store` / `Cache` / `Logger` (note required vs. capability-gated).
- **Lifecycle events** — new event names or payload shapes on the public bus.
- **Public types** — new exported types, or new fields on existing exported types.

For each, give the final name and signature. Naming follows the conventions in
[CLAUDE.md § Naming conventions](../CLAUDE.md#naming-conventions).

## Alternatives considered

The designs you rejected and why. This is the part that won't survive in the diff
once the code merges, so it's the most valuable section. Include "do nothing" if
the status quo was a real option.

## Stability / charter impact

- Which [STABILITY.md](../STABILITY.md) category does the new surface fall under
  (Builder API, `IAct`, adapter contracts, lifecycle events, public types)?
- Is anything here **breaking** (rename, removal, narrowed type, changed
  semantics), or is it all **additive**? Breaking changes need a `BREAKING CHANGE:`
  footer and a migration note.
- If this adds a port method, what's the plan for the TCK and every in-tree
  adapter (InMemory / act-pg / act-sqlite / act-pino)?

## Open questions

Anything unresolved you want reviewers to weigh in on. Delete if none.
