---
description: Show stability-charter-covered changes on this branch and demand a categorization
allowed-tools: Bash(git:*), Read
---

Print every change on the current branch that touches a STABILITY.md-covered surface, and force a categorization (additive vs. breaking) before merge.

## Charter-covered surfaces (from STABILITY.md)

1. `libs/act/src/builders/{act,state,slice,projection}-builder.ts` — the fluent builder DSL
2. `libs/act/src/act.ts` — the `IAct` interface and lifecycle event shapes
3. `libs/act/src/types/ports.ts` — `Store`, `Cache`, `Logger` interfaces
4. `libs/act/src/types/index.ts` (and what it re-exports) — public type surface
5. `libs/act/src/ports.ts` — public port singletons and `SNAP_EVENT` / `TOMBSTONE_EVENT`

## Steps

1. Run `git diff master --name-only` and filter for those paths.
2. For each touched file, run `git diff master -- <file>` and skim. Classify each change:
   - **Additive**: new optional method, new optional field, new exported type, new event name, widened input union.
   - **Breaking**: rename, removal, narrowed type, changed semantics, removed event name.
3. Print a table:
   | File | Change shape | Classification | Migration note needed? |
4. If any change is **breaking**, demand:
   - A `BREAKING CHANGE:` commit footer somewhere on the branch.
   - A written migration note in `RELEASE_NOTES_*.md` or the changelog.
   - The PR title prefix `feat!` or `fix!`.
5. If no charter-covered files were touched, print "No charter-covered surface changed." and exit.

## Conventions

- Don't guess on classification — when ambiguous, ask the user.
- Read `STABILITY.md` directly if uncertain about a specific surface.
- A signature widening from `string[]` → `string[] | Filter` is **additive** (any caller passing `string[]` still works). A narrowing or rename is **breaking**.
