# Contributing

The rules [CLAUDE.md](CLAUDE.md) states in one line each are spelled out here: the pre-handoff workflow, naming conventions and config-validation schemas.

## Pre-handoff workflow

Branch work isn't done until `/release-check` passes cleanly and every CI check on the PR is green. Per-slice `pnpm test -F <pkg>` during development is fine; CI is the final gate. GitHub doesn't block merging a red PR, so read every check before merging.

Sequence at the end of a feature branch:

1. `/release-check` — regenerates and classifies the stability snapshot, runs the doc audit (step 3) and lint, then pushes and reads every CI check (typecheck, lint, tests with 100% coverage, build, stability and the repo checks). A coverage gap fails CI; write the fault-injection test or remove the branch (patterns in `libs/act-pg/test/store.error.spec.ts` / `libs/act-sqlite/test/store.error.spec.ts`). See [.claude/commands/release-check.md](.claude/commands/release-check.md).
2. **Learnings.** If the change taught something that `.claude/skills/simplify-core/learnings.md` doesn't already say, add one entry there: the rule in one line, then the ticket as evidence. Most PRs add nothing.
3. **Doc audit — any PR that changes a public surface, renames a method, migrates a callsite to a new primitive, or alters described semantics must update the relevant docs in the same PR.** Run the stale-reference grep:
   ```bash
   grep -rln "<old-name-or-shape>" docs/docs CLAUDE.md STABILITY.md libs/*/README.md
   ```
   Hits get fixed inline; **do not** leave them for a "follow-up PR." Specifically:
   - **Port changes** (`Store` / `Cache` / `Logger`) → check `docs/docs/architecture/extension-points.md` and the matching `docs/docs/guides/writing-a-{store,cache,logger}.md`. The method-list snippet in extension-points goes stale every time the interface gains, loses, or renames a method.
   - **Orchestrator / `Act` API changes** → check `docs/docs/concepts/` (especially `event-sourcing.md`, `error-handling.md`, `state-management.md`).
   - **Internal subsystem refactors** (close-cycle, drain, settle, correlate) → check the matching `docs/docs/architecture/` page. Pseudocode and ASCII pipeline diagrams there often spell out the *old* shape ("Phase X: query backward, limit:1") — grep for the literal description, not just the method name.
   - **Lifecycle event additions/changes** → check `docs/docs/concepts/error-handling.md` and `docs/docs/guides/production-checklist.md`.
   The pattern that catches this: the PR's commit message says "we changed X" — every place that *describes* X in the docs needs the same update. Treat the docs as part of the public surface.

   **A doc claim about runtime behavior ships with its test.** Any sentence in `docs/docs/**` or a public port/`Act` doc-comment that asserts a concrete runtime guarantee ("`with_snaps` resumes from the latest snapshot", "the cache is invalidated only on `ConcurrencyError`") must have a TCK or unit test that fails if the claim stops holding, and a row in the [behavior-contract checklist](docs/docs/architecture/behavior-contracts.md): a one-line claim, a link to the doc section that explains it, and the exact test names. No rationale or ticket numbers in the row. `pnpm check:contracts` (run in CI) fails when a cited test doesn't exist, so a test rename updates its row in the same PR.
4. Only then: announce "ready for review", show the diff summary, offer to open a PR via `/pr`.

**Don't invent ad-hoc gates.** A local `pnpm typecheck` or a glance at `pnpm test` doesn't substitute for CI's result. Narrow to ad-hoc tooling only for targeted debugging mid-development.

Each step closes a failure mode that has actually shipped: per-slice test runs missed what the full gate catches, and PRs that changed described behavior left the docs describing the old shape.

## Naming conventions

The codebase uses two distinct casings. Which one you pick is determined by **whether the identifier is on the public surface or not** — there is no third "shifting style by context" option.

**Public — camelCase. This is the convention, not a legacy carve-out.**

Anything reachable from a package's `src/index.ts` (or subpath `index.ts` for `act-http`/`act-ops`) is camelCase:

- Exported functions: `verifyWebhook`, `applyPatchMessage`, `withIdempotency`, `runStoreTck`, `webhookMiddleware`, `minSafeTtl`, `extractIdempotencyKey`, `checkWebhook`.
- Public type fields: `IAct.forget` return `{eventCount}`, `forgotten` event `eventCount`, `StateNode.varName`, `EventNode.hasCustomPatch`, `WebhookConfig.timeoutMs`/`idempotencyKey`, `HttpDeliveryErrorInit.responseBody`, `VerifyOptions.maxAgeSeconds`, `RetryProfile.safetyFactor`, `Projection.batchHandler`, `QueryStreamsResult.maxEventId`, `InMemoryIdempotencyStore` options `ttlMs`/`maxEntries`/`retryProfile`.
- ActOptions / RetryOptions / ReactionOptions / Backoff / DrainOptions / SettleOptions / LaneConfig fields: `maxRetries`, `blockOnError`, `baseMs`, `maxMs`, `jitter`, `strategy`, `leaseMillis`, `eventLimit`, `streamLimit`, `cycleMs`, `debounceMs`, `maxSubscribedStreams`, `onlyLanes`, `settleDebounceMs`, `maxPasses`, `expectedVersion`, `reactingTo`, `asOf`, `maxSize`.
- Builder methods: `withState`, `withProjection`, `withReaction`, `withActor`, `withLane`, `withSlice`.
- Top-level factories: short single-word lowercase — `act`, `state`, `slice`, `projection`, `sensitive`, `webhook`, `receiver`.
- Public class names + types — PascalCase always: `StateNode`, `BroadcastChannel`, `InMemoryStore`, `ConsoleLogger`, `RetryProfile`, `WebhookConfig`, `IdempotencyStore`. Suffix with `XxxOptions` / `XxxResult` / `XxxConfig` when applicable.

**Internal — short snake_case, no exceptions:**

- Internal helper functions: `run_close_cycle`, `classify_registry`, `compute_backoff_delay`, `build_handle`, `merge_event_register`, `current_version_of`.
- Local variables: `event_to_state`, `last_event_name`, `stream_info`, `raw_body`, `headers_bag`.
- Function parameters: TS doesn't enforce parameter names as part of the public contract (callers pass positional args), so parameters are snake_case even on public method signatures — `event_name`, `state_name`, `skip_validation`.
- Private/protected class fields and methods: `_snake_case` with underscore prefix — `_drain_controllers`, `_event_to_lanes`, `_arm_all`, `_wire_notify`, `_max_event_id_by_stream`.
- Internal type fields (types not re-exported through any `src/index.ts`): `Classification.static_targets`, `HandleResult.next_attempt_at`, `AuditPass.on_event`, `SettleDeps.on_settled`.
- Grouping prefixes/postfixes when several related identifiers share a structural role: `pii_*`, `make_*`, `is_*`, `compute_*`, `*_by_stream`.

**Parameter properties are banned** by `erasableSyntaxOnly`: declare each field explicitly above the constructor and assign in the body. Constructor parameter names stay camelCase (matches the external call site); rename to `_snake_case` only on the assignment to the field.

**The boundary is enforced mechanically** by `runStabilityTck` from `@rotorsoft/act-tck`. One spec, `test/stability.spec.ts` (at the repo root, so a snapshot change never releases a package), discovers every `@rotorsoft/*` package under `libs/` and snapshots the published declarations (`dist/@types`) of each entry point declared in its `exports`, following its relative re-exports. Any rename / removal / signature change on the public surface shows up as a snapshot diff in the PR; an implementation change doesn't. New packages and subpaths are picked up automatically. It reads `dist/`, so it runs after `pnpm build` as `pnpm check:stability` (`-u` to regenerate), not in `pnpm test`.

## Config-validation schemas

Any options bag that ships to `act().build()` / `openapi(app, ...)` / similar entry points is validated with Zod, not hand-written `if (x < min) throw` ladders. Out-of-range values throw `ZodError` at the entry point so misconfiguration surfaces at startup, not on the first cycle tick. The standard:

| Element | Convention |
|---|---|
| Schema name | `<Type>OptionsSchema` — `AutocloseOptionsSchema`, `SseOptionsSchema`, `OpenAPIOptionsSchema` |
| Schema visibility | Internal `const`, never re-exported. The public surface is the type + resolver, not the schema itself. |
| Config type | Internal: `type <Type>Config = z.infer<typeof <Type>OptionsSchema>`. Public: written out in `types/`, and the schema ends in `satisfies z.ZodType<…>`, so a schema whose output stops fitting the type fails to compile (a field added to the type but not the schema still compiles, and parsing drops it: add both together). |
| Resolver | `resolve<Type>Config(options: <Type>Options): <Type>Config` — camelCase, parses + applies defaults in one call |
| Defaults | `DEFAULT_*` SCREAMING_SNAKE constants, referenced from the schema via `.default(DEFAULT_*)` so there's one source of truth; a public default lives in `types/act.ts` |
| Custom error messages | `{ message: "..." }` on the individual constraint when callers depend on the wording (test assertions, structured logs). Don't override Zod's default for shape errors callers don't read. |

**Single home:** every builder-facing act-core config bag (schema + resolver + private `DEFAULT_*`) lives in **`libs/act/src/internal/config.ts`**; a resolver that is public (`resolveAutocloseConfig`) is a one-line wrapper in the public `config.ts` — one discoverable module, one section per bag (`Backoff`, `Reaction`, `Action`, `Lane`, `Drain`/`Settle`, `Act`, `Autoclose`, `CircuitBreaker`, `Fold`). Feature logic (the `CircuitBreaker` state machine, the fold engine, the autoclose window math in `autoclose-window.ts`) imports its resolved-config type from there. A new config bag adds a section to `config.ts` and wires its `resolve<Type>Config` at the declaration/runtime site (`.on(...)` / `.do(...)` / `.withLane(...)` / `act().build(...)` / `drain(...)` / `settle(...)`) — never a hand-rolled range check. Validation is fail-closed but non-tightening: reject `NaN`/`±Infinity`/nonsensical-negatives, never newly reject a value that works today. The sibling env/package config (`config()`) stays in the public `libs/act/src/config.ts`; `@rotorsoft/act-http` transport bags (`sse-wiring.ts`, `openapi/index.ts`) stay in that package. Never reinvent `*_MIN` / `*_MAX` companion constants or scatter ladders across the resolver.

## Performance Optimization Workflow

Pattern used for Act framework performance tickets. Follow this process when creating and implementing optimization issues.

### Phase 1: Analysis

1. Deep-read the current implementation — all relevant source files with line numbers
2. Identify the bottleneck with specific code paths and data flow
3. Name the pattern being applied (e.g., "competing consumers", "cursor-based processing")
4. Map existing mechanisms (watermarks, frontiers, caches) before proposing new ones
5. Understand why the current approach works before changing it

### Phase 2: Issue Creation

Each issue should include:

- **Problem** — current behavior with code references, impact at scale
- **Pattern** — named pattern with explanation (e.g., `FOR UPDATE SKIP LOCKED`, cursor-based processing)
- **Strategy** — implementation approach with interface changes, SQL, and code sketches
- **Benchmarking plan** — specific scenarios to measure, before/after methodology
- **Documentation tasks** — CLAUDE.md, READMEs, Docusaurus, skills, PERFORMANCE.md
- **Acceptance criteria** — checklist including tests, docs, and benchmark results

### Phase 3: Implementation

- Present plan and get confirmation before coding
- Use short names matching existing vocabulary (`claim`, `subscribe`, `max_at`)
- Classify behaviors at build time when possible (static vs dynamic resolvers)
- Reuse existing mechanisms (watermarks as checkpoints) before creating new ones
- Keep the Store interface minimal — fold implementation details into existing methods
- Run tests after every change

### Phase 4: Benchmarking

- Write benchmarks that exercise the **exact scenario** being fixed
- Separate benchmarks per optimization dimension when a ticket solves multiple problems
- Run on master code (checkout source, build, run) for real before/after comparison
- Run on feature branch with same benchmark for after numbers
- Report honestly — if numbers are within noise, say so and explain the architectural value

### Phase 5: Documentation

- **`libs/act/PERFORMANCE.md`** — detailed benchmark tables, pattern explanation, before/after comparison
- **`libs/act/README.md`** — current patterns only, link to PERFORMANCE.md for history
- **`docs/docs/architecture/extension-points.md`** — the Store contract, when the change touches it
- **Docusaurus** — concept pages with optimization notes
- **Scaffold skill** — update `act-api.md` as needed
- Verify Docusaurus build passes before PR

### Key Principles

- Understand existing mechanisms deeply before proposing new ones
- Don't add to the Store interface unless strictly necessary — fold into existing methods
- Benchmarks must show real improvement in the specific scenario being fixed
- Multiple optimizations in one ticket need multiple benchmarks
- Document the pattern, not just the code — explain why it works

## Dependency Updates

This repo uses **Renovate** for version updates and **Dependabot for security alerts only**. There is no `.github/dependabot.yml` — please don't open Dependabot version-update PRs; Renovate already handles them.

- **Direct deps** — Renovate opens PRs grouped by `Types packages` and `Dev dependencies`. Patch updates auto-merge; minor/major need review.
- **Lockfile maintenance** — runs weekly (Mon < 03:00 UTC) to refresh transitive resolutions.
- **Stuck transitive vulnerabilities** — when a transitive dep can't be lifted by Renovate (the parent hasn't released, or the resolution graph won't bump), pin it in the `overrides` block of `pnpm-workspace.yaml`. Use a version-range key so the override is scoped to the vulnerable range only.
- **Vulnerability alerts** — Dependabot security alerts are enabled. Triage promptly; fix via Renovate PR, manual `pnpm update`, or an `overrides` entry in `pnpm-workspace.yaml` depending on where the vuln sits in the tree.
