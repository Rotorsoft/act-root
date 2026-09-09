# RFC 1650: act-diagram pipeline exports

- **Status:** draft
- **Issue:** #1650
- **Author:** rotorsoft
- **Created:** 2026-09-09

## Motivation

`@rotorsoft/act-diagram` renders an Act domain model as an interactive SVG. The
supported way in is `ActDiagram`, which owns the whole pipeline: it takes files,
sorts them, executes them, builds the model, validates it, lays it out, and
renders. For a host that wants exactly that, it is the right shape.

The IDE integrations want less than that. `act-nvim` and the VS Code extension
drive the diagram from an editor, where the files are already in memory, the
model is worth caching across renders, extraction is worth moving off the UI
thread, and click-to-source has to resolve a name to a file and line without
rendering anything at all. Every one of those needs a stage on its own.

The package's README has documented those stages as public API for some time —
a `Functions` table naming `extractModel`, `buildModel`, `navigateToCode`,
`topoSort`, `computeLayout`, `parseMultiFileResponse`, `stripFences` and
`deriveProjectName`, plus a "Bring-your-own pipeline" example importing them.
None of it resolved. The functions exist under internal snake_case names, are
not on the entry point, and the `exports` map has no subpath, so they were not
reachable by any spelling, including a deep import (#1650). The documentation
described the API this RFC is proposing; the code never had it.

Today a plugin either re-implements a stage or vendors the source. This makes
the documented surface real.

## Public surface added

New exports from `@rotorsoft/act-diagram` (the only entry point; there are no
subpaths). Public spellings are camelCase per the naming convention, while the
implementations keep their internal snake_case names:

- `extractModel(files: FileTab[]): { model: DomainModel; error?: string }` —
  the whole extraction: topological sort, execution, model build.
- `topoSort(files: FileTab[]): FileTab[]` — order files so imports precede
  importers.
- `computeLayout(model: DomainModel): Layout` — positions nodes, edges and
  slice boxes. Pure.
- `navigateToCode(files: FileTab[], name: string, type?: string, targetFile?: string): NavigateResult | undefined`
  — resolve a named element to `{ file, line, col }`. Pure, renders nothing.
- `parseMultiFileResponse(raw: string): FileTab[]` — parse a path-annotated
  multi-file AI response.
- `stripFences(code: string): string` — strip markdown fences from generated
  code.
- `deriveProjectName(prompt: string, code?: string): string` — best-effort
  project name from a prompt and optional generated code.

New public types, required to make the above usable:

- `Layout` — the `computeLayout` result.
- `LayoutNode`, `LayoutEdge`, `LayoutBox`, `LayoutPos` — the members of
  `Layout`, aliased on export from their internal names `N`, `E`, `Box` and
  `Pos`. One-letter type names are fine internally and not fine on a public
  surface.
- `NavigateResult` — `{ file: string; line: number; col: number }`. Promoted
  from a module-local type to an exported one.

`validate(model)` and `emptyModel()` were already exported and are unchanged.

### Deliberately not promoted

`buildModel(result, files, expectedSlices)` stays internal. Its first parameter
is an `ExecuteResult`, produced only by `execute`, which is not exported — so
promoting `buildModel` alone would ship a function no caller could invoke, and
promoting it usefully means also promoting `execute` and `ExecuteResult`, which
is the transpile-and-run internals rather than a pipeline stage. `extractModel`
covers what a host needs, and the README's own gloss described `buildModel` as
the lower-level half of it. If a real use case appears, that is a separate RFC
with a smaller question in front of it.

## Alternatives considered

**Delete the README rows (do nothing to the code).** This was the first shape of
the #1650 fix, and it is the honest minimum: the documentation stops lying, no
surface grows, no compatibility is owed. Rejected because the plugins genuinely
need the stages, and the documentation was describing an intended API rather
than hallucinating one. Deleting would have left the real need unserved and the
plugins on vendored code.

**Add a `/pipeline` subpath rather than widening the root entry.** Keeps the
component-facing entry small, which is a real virtue for a package whose main
consumer imports React components. Rejected as premature: the package has one
entry point today, seven functions is not a crowd, and a subpath is itself
permanent surface. Splitting later is additive; unsplitting is not.

**Export the internal snake_case names as-is.** Smaller diff, no aliases.
Rejected because the naming convention is explicit that anything reachable from
`src/index.ts` is camelCase, and the README had already documented the camelCase
spellings — the names in the alias are the names users were told to write.

**Export `Layout`'s members under their internal names.** `N`, `E`, `Box`, `Pos`
are legible in a layout module and meaningless in a consumer's import list.
Aliasing costs one line each.

## Stability / charter impact

**Category:** public types and package exports for `@rotorsoft/act-diagram`.
Not `IAct`, not a builder API, not a port contract — no adapter or TCK impact.

**Additive.** Every entry is new; nothing is renamed, removed, narrowed or
changed in meaning. Existing imports are untouched, and `ActDiagram` continues
to drive the same stages internally. No `BREAKING CHANGE:` footer, no migration
note.

What it commits us to: these seven signatures and three type shapes become
protected surface, and the stability snapshot will fail on any change to them.
That is the cost of the RFC being accepted, and it is why `buildModel`,
`execute` and `ExecuteResult` are excluded rather than swept in.

`act-diagram` is not covered by the framework's `STABILITY.md` charter, which
governs `@rotorsoft/act` and the port contracts.

**It is not covered by the stability snapshot either, and that is a gap this
RFC opens.** `all-packages-stability.spec.ts` excludes the package by name via
`UI_PACKAGES`, on the stated reasoning that it "is mostly a UI tool (React
components, `.tsx`)" and that "React-component public types … don't belong in a
snake-case-or-camelCase rename gate."

That reasoning held while the package's surface was five components plus
`validate` and `emptyModel`. It does not hold for what this RFC adds: seven
plain functions and four plain types, which are library surface by any reading
and exactly what the snapshot exists to protect. So the surface the IDE plugins
are about to depend on has no mechanical guard against a rename — the failure
mode this package's own README already demonstrated at length (#1650).

The `rfc-gate` is silent for the same reason: it triggers on snapshot growth,
and an excluded package cannot grow the snapshot. This RFC is therefore
voluntary rather than gate-forced, which is itself evidence the exclusion is
now too wide.

See the open question below.

## Open questions

- **Should `act-diagram` come off the `UI_PACKAGES` exclusion?** My
  recommendation is yes, and that it happens with or shortly after this change,
  because this is what makes the new surface enforceable. The narrow version is
  to snapshot the package like any other; the component exports ride along,
  which the current comment argues against but which costs little beyond some
  `.tsx` text in the snapshot. The alternative is a package-local
  `stability.spec.ts` scoped to the non-component exports. Deliberately left out
  of this PR: it changes shared snapshot infrastructure and deserves its own
  review rather than riding in on a docs-and-exports change.
- Is `deriveProjectName(prompt, code?)` the signature we want to commit to? It
  is the one the code has, but the README documented `deriveProjectName(files)`,
  so at least one reader expected a different shape. Worth a look from whoever
  owns the AI-pipeline path before this is accepted.
