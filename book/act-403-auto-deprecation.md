# ACT-403 — auto-deprecation via `_v<n>` convention

For the schema-evolution chapter. Builds on top of the versioned-event-names pattern already discussed (and shipped in the framework's `event-schema-evolution.md`).

**The core point for the chapter:** the `_v<digits>` convention isn't just a developer convention — it's a contract the framework reads. Adding `Foo_v2` to `.emits({...})` auto-marks `Foo` as deprecated. There's no `.deprecate(...)` API call, no metadata, no marker to forget. The naming convention does the work.

**What the framework does with the signal (ACT-403):**

1. **Build-time throw** when a static `.emit("Foo")` targets a deprecated event. The `app.build()` call refuses to construct the orchestrator until the call site is updated to `.emit("Foo_v2")`.
2. **Startup advisory** — a single info log at `app.build()` enumerates every deprecated event in scope, with its current version and owning state. The same data is exposed programmatically via `app.registry.deprecated_events(state_name)` for callers that want their own policy (a CI gate, a metrics tag, an opt-in Logger warn). Dynamic `.emit((a) => ["Foo", ...])` callbacks escape the static check but show up in the advisory all the same — *every* deprecated event the registry knows about is named at boot. The orchestrator and `event-sourcing.ts` stay deprecation-unaware: the registry holds the data, the build-time channel surfaces it, no per-action runtime warn.
3. **Silent on the read path.** `.patch({ Foo: ... })` reducers are required forever (immutable history) — replay of historical events must not warn.

**The chapter's "aha" moment:** the asymmetry between *emit* and *reduce*. Deprecation in event sourcing is fundamentally about not WRITING new instances of a legacy event; the read path keeps reducers alive for the lifetime of the system. The framework encodes that asymmetry directly.

**Edge cases worth a callout in the chapter:**

- **Gaps allowed.** `{Foo, Foo_v3}` (no `Foo_v2`) deprecates `Foo`, `Foo_v3` is current. Skipped numbers happen when a v2 migration was aborted or rolled back; the framework doesn't require contiguity.
- **`_v1` is literal.** Version suffixes start at 2 (the base name is implicitly v1). Writing `Foo_v1` makes it a distinct event with no grouping; don't.
- **Rolling deploys work.** Old instances already built before the migration keep emitting the legacy name and running fine; new instances build with both schemas registered and throw if any static `.emit()` still targets the legacy name. Each build is atomic; the deploy is rolling.

**No opt-out flag in the framework.** The chapter can frame this as a principled stance: a `--allow-deprecated-emit` would invite developers to silence the throw instead of fixing the one-character rename. Forcing the rename is the point.

**Connect back to ACT-401:** both checks (cross-slice schema reference identity + auto-deprecation) share the same load-bearing idea — *the framework enforces contracts the type system can't see*. TypeScript can't tell that two `z.object({...})` calls have different refinements, can't tell that `.emit("OrderPaid")` references a version that's been superseded. The framework owns that gap.

**Runtime cost is exactly zero.** The action path runs no deprecation check at all — `event-sourcing.ts` is unaware the concept exists. All of the work happens at build time (the static-emit scan, the advisory log, populating `registry.deprecated_events`); the hot path is the same code whether or not the registry holds any deprecated names. Worth mentioning so readers don't worry about a "policy tax."

**Wolfdesk in the repo doesn't use this yet** (no schema migrations there). A made-up example for the chapter works fine — `OrderPaid` → `OrderPaid_v2` after a currency field was added.
