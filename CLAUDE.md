# CLAUDE.md

Guidance for Claude Code working in this repository. This file is the **index**: brief project meta, plus pointers into `docs/docs/` (Docusaurus, for humans) and `.claude/skills/` (for Claude when building Act apps). When in doubt, follow the link.

## Before you start

This file is auto-loaded into context — that is not the same as having read it. Before drafting a slice plan or making the first edit, deliberately consult:

1. **Working on a branch** — `git branch --show-current` should not return `master` (or `main`). If it does, create a feature branch first (`act-<issue>-<slug>`); never accumulate edits or commits on master.
2. **Development Workflow** — the "Changing a port interface" rule, the "Pre-handoff workflow," the doc audit step. If a slice touches `libs/act/src/types/ports.ts`, updating `libs/act-tck/src/` is part of the same slice, not a follow-up.
3. **Rules for contributing to this repo** — durable workflow rules (100% coverage gate, naming, no manual version bumps, integration helpers in separate packages, no `--no-verify`).
4. **Safety-critical one-liners** — load-bearing per-feature gotchas. Re-skim the ones relevant to the file you're about to change.

Skipping this checklist is how duplicated work (per-adapter tests that should have lived in the TCK), master-branch edits, and unnecessary major bumps slip in. Read the rules first; they answer most "should I…?" questions before they reach the user.

## Overview

Act is an event sourcing + CQRS framework for TypeScript, built around DDD aggregates and reaction-driven workflows. The core philosophy: any system distills into **Actions → {State} ← Reactions**.

## Project Structure

pnpm monorepo with two main sections:

- **`/libs`** — core framework libraries
  - `@rotorsoft/act` — core event sourcing framework
  - `@rotorsoft/act-pg` — PostgreSQL adapter (production)
  - `@rotorsoft/act-sqlite` — SQLite/libSQL adapter (embedded/single-node)
  - `@rotorsoft/act-patch` — immutable deep-merge patch utility
  - `@rotorsoft/act-sse` — Server-Sent Events for incremental state broadcast
  - `@rotorsoft/act-http` — HTTP integrations (umbrella): `webhook` for reaction-driven POST delivery, plus an `sse` submodule that mirrors `@rotorsoft/act-sse`
  - `@rotorsoft/act-pino` — pino-backed `Logger` adapter
  - `@rotorsoft/act-ops` — operational primitives (idempotency, retry budgets, poison-message classification). **Zero dep on `@rotorsoft/act`** by design — so non-Act receivers (forwarded-bus consumers, Express endpoints, queue workers) can speak the same contract without pulling in the orchestrator
  - `@rotorsoft/act-tck` — Test Compatibility Kit for Store/Cache/Logger ports

- **`/packages`** — example applications
  - `calculator` — simple state machine; rebuild and close demos
  - `wolfdesk` — complex ticketing (from "Learning Domain-Driven Design")
  - `server`, `client` — tRPC + React example

## Common Commands

```bash
pnpm install          # install
pnpm build            # build all packages
pnpm test             # run all tests with coverage
pnpm typecheck        # tsc --noEmit
pnpm lint / lint:fix  # biome
pnpm clean            # remove build artifacts
pnpm scrub            # remove all node_modules + build artifacts

pnpm dev:calculator   # run examples
pnpm dev:wolfdesk
pnpm dev:trpc         # server + client concurrently

vitest                                                # watch mode
pnpm -F calculator test                               # one package
vitest packages/calculator/src/__tests__/calculator.test.ts  # one file

pnpm -F shared drizzle:migrate   # migrations (also auto-run before tests)

pnpm act                                  # interactive contracts explorer (current dir)
pnpm act packages/wolfdesk                # explore a specific package
pnpm act -q TicketOpened                  # non-interactive: print one entity, exit
```

## Important Constraints

- **Node ≥ 22.18.0**, **pnpm ≥ 10.32.1** (not npm/yarn)
- TypeScript strict mode everywhere
- All actions, events, and state require Zod schemas
- Events are immutable — never mutate event data; evolve via [versioned event names](docs/docs/architecture/event-schema-evolution.md)
- All actions need actor context (`{ id, name }`)
- ESM only (`"type": "module"`, `.js` import extensions)
- Public API stability is governed by [STABILITY.md](STABILITY.md) — read before changing any builder API, `IAct` method, `Store`/`Cache` contract, lifecycle event, or public type export

## Commit Message Format

Conventional commits, validated by hook:

```
<type>(<scope>): <subject>

# Types: feat, fix, docs, style, refactor, test, chore
# Scope: package name (act, act-pg, calculator, wolfdesk, etc.)
# Subject: imperative mood, lowercase, no period
```

## Where to find what

### Building an Act application

When the user wants to scaffold or extend an app using Act, use the **`scaffold-act-app`** skill. It owns the full app-building surface: spec parsing, state/slice/projection design, monorepo layout, tRPC API, React client, SSE wiring, tests. The skill description triggers it automatically when the user asks to build, scaffold, or translate a domain model.

### Inspecting an Act app from the terminal

The **`act`** CLI (shipped from `@rotorsoft/act-diagram` as a `bin`) is the build-time companion to `act-inspector`. Where the inspector shows runtime state, `act` shows the **structural contract** — every event, action, slice, projection, state, and reaction the parser can see, with producer/consumer relationships, captured Zod schemas, and deprecation status (via the `_v<n>` convention). Detail views can jump straight into `$EDITOR` at the source line.

- `pnpm act` — interactive: pick a category → entry → view detail → optionally open in `$EDITOR`.
- `pnpm act -q <name>` — non-interactive, exits after printing. Used by CI smoke tests in `ci-cd.yml`.

If schemas aren't being captured for an event, the parser is best-effort: it walks `.emits({...})` literally. Shorthand (`{ TicketOpened }`) records the identifier name; explicit Zod expressions are captured verbatim.

### Framework reference (Docusaurus)

| Topic | File |
|---|---|
| Project intro & key concepts | [docs/docs/intro.md](docs/docs/intro.md) |
| State/Slice/Projection/Act builders | [docs/docs/concepts/state-management.md](docs/docs/concepts/state-management.md) |
| Event sourcing model, settle, lifecycle events, projection rebuild, close-the-books | [docs/docs/concepts/event-sourcing.md](docs/docs/concepts/event-sourcing.md) |
| Configuration, snapshotting, batched projection replay | [docs/docs/concepts/configuration.md](docs/docs/concepts/configuration.md) |
| Errors, retry pattern, blocked streams, debugging | [docs/docs/concepts/error-handling.md](docs/docs/concepts/error-handling.md) |
| Testing patterns | [docs/docs/concepts/testing.md](docs/docs/concepts/testing.md) |
| Real-time / SSE | [docs/docs/concepts/real-time.md](docs/docs/concepts/real-time.md) |
| Optimistic concurrency, leasing, **why no framework-level dedup** | [docs/docs/architecture/concurrency-model.md](docs/docs/architecture/concurrency-model.md) |
| Cache, snapshots, **time-travel queries** | [docs/docs/architecture/cache-and-snapshots.md](docs/docs/architecture/cache-and-snapshots.md) |
| Correlation, drain, settle internals | [docs/docs/architecture/correlation-and-drain.md](docs/docs/architecture/correlation-and-drain.md) |
| Cross-process reactions (`Store.notify`) | [docs/docs/architecture/cross-process-reactions.md](docs/docs/architecture/cross-process-reactions.md) |
| Reaction priority lanes (saturated drain) | [docs/docs/architecture/priority-lanes.md](docs/docs/architecture/priority-lanes.md) |
| Close-the-books phase semantics | [docs/docs/architecture/close-cycle.md](docs/docs/architecture/close-cycle.md) |
| Event schema evolution (versioned event names) | [docs/docs/architecture/event-schema-evolution.md](docs/docs/architecture/event-schema-evolution.md) |
| Store / Cache / Logger contracts and adapters | [docs/docs/architecture/extension-points.md](docs/docs/architecture/extension-points.md) |
| Production deployment checklist | [docs/docs/guides/production-checklist.md](docs/docs/guides/production-checklist.md) |
| Database-backed projections (Drizzle, batched replay) | [docs/docs/guides/projections-to-database.md](docs/docs/guides/projections-to-database.md) |
| External integration (inline `webhook` vs forwarded bus, idempotency contract, recovery) | [docs/docs/guides/external-integration.md](docs/docs/guides/external-integration.md) |
| Adding a new `@rotorsoft/act-*` package | [docs/docs/guides/contributing-new-package.md](docs/docs/guides/contributing-new-package.md) |
| Inspecting contracts with the `act` CLI | [docs/docs/guides/contracts-cli.md](docs/docs/guides/contracts-cli.md) |

### Performance evidence

Per-package `PERFORMANCE.md` files track benchmark history with before/after numbers per optimization. READMEs link to them; READMEs themselves stay narrative.

- `libs/act/PERFORMANCE.md` — drain/cache/correlate
- `libs/act-pg/PERFORMANCE.md` — Postgres-specific (incl. `notify` latency)

**Benchmarks must run on real adapters.** InMemoryStore is the fastest possible read/write path (no I/O, no SQL planner) — measuring perf optimizations against it understates wins and ignores the index/lock/connection-pool dimensions that the production adapters live in. Every perf claim that ships in a `PERFORMANCE.md` table needs numbers from `act-pg` (port 5431 docker) or `act-sqlite`. InMemory may appear as a baseline reference, never as the primary number. New benches go in the relevant adapter package's `bench/` or `scripts/`, not just `libs/act/bench/`.

## Safety-critical one-liners

These are easy to get subtly wrong. Read the linked docs before editing related code.

- **Cross-process reactions:** call `store(adapter)` *before* `act()...build()` — the orchestrator wires the `notify` subscription at construction. Late injection silently does nothing. Scoped Acts (`ActOptions.scoped`) bind notify against `options.scoped.store` instead — same contract, different source. See [cross-process-reactions](docs/docs/architecture/cross-process-reactions.md).
- **Per-Act scoped ports:** `ActOptions.scoped` requires **both** `store` and `cache` together — sharing a cache across distinct stores would collide on stream keys. The framework threads the bag via AsyncLocalStorage; internal `store()`/`cache()` calls resolve transparently. Use for multi-tenant SaaS, parallel test workers, or hybrid storage. Single-tenant apps stay on the singleton path. See [extension-points.md § Scoped ports](docs/docs/architecture/extension-points.md).
- **Projection rebuild:** always `app.reset(targets)`, never `store().reset(targets)` directly. Only `app.reset` raises the orchestrator's drain-armed flag — without it, a settled app short-circuits and skips the replay. See [event-sourcing.md § Projection Rebuild](docs/docs/concepts/event-sourcing.md).
- **Blocked-stream recovery — `unblock` resumes, `reset` rebuilds.** A stream blocks on `retry >= maxRetries` *or* when a handler throws `NonRetryableError` (the latter blocks on first attempt). Recovery path is `app.unblock(input)` — preserves the watermark, stream resumes from where it stopped. `app.reset(input)` is for projection rebuilds: it sets the watermark to `-1` and replays every event. Don't confuse them — using `reset` to "clear a blocked webhook" would re-fire every historical webhook. Both accept either `string[]` or a `StreamFilter` (regex/exact/source/blocked). Use `app.blocked_streams()` to discover what's blocked before recovering. See [error-handling.md § Blocked Streams](docs/docs/concepts/error-handling.md).
- **Non-retryable errors signal permanent failure.** `NonRetryableError` (exported from `@rotorsoft/act`) tells drain "this is permanent, block now" — the finalizer recognizes `error instanceof NonRetryableError` and forces `block = blockOnError` regardless of `lease.retry`. Use it in handlers for failures that won't recover on retry (4xx responses, validation errors, "user deleted" 404s). `act-http/webhook` already throws `NonRetryableWebhookError` for 4xx. **It does not override `blockOnError: false`** — operators who explicitly opted out of blocking keep that behavior. See [error-handling.md § Non-retryable errors](docs/docs/concepts/error-handling.md).
- **Reactions auto-inject `reactingTo`:** inside a slice handler, `app.do(...)` automatically threads the triggering event as `reactingTo`. Pass an explicit fourth argument only when overriding. See [state-management.md § Auto-injected `reactingTo`](docs/docs/concepts/state-management.md).
- **Single-key records:** `state({})`, `.on({})`, `.emits({})` accept exactly one key. Multi-key throws at runtime.
- **Cross-slice event schemas:** when two same-name state partials declare the same event in `.emits({...})`, both must reference the **same Zod schema instance**. The merge throws on different references — extract shared event schemas to a module (`export const TicketOpened = z.object({...})`) and import in every slice that declares them. See [state-management.md § Cross-slice event schemas](docs/docs/concepts/state-management.md).
- **Deprecated event versions throw on emit:** the `_v<digits>` naming convention is load-bearing. Adding `Foo_v2` to `.emits({...})` auto-deprecates `Foo`; any static `.emit("Foo")` targeting the legacy version throws at `act().build()`. Reducers (`.patch({Foo: ...})`) stay silent — replay of historical events never warns. Dynamic emits warn once per process per event name. See [event-schema-evolution.md § The versioning convention is the deprecation signal](docs/docs/architecture/event-schema-evolution.md).
- **Tests:** prefer `fixture(builder)` from `@rotorsoft/act/test` for the common case (per-test isolation, parallel-safe, auto-cleanup) and `sandbox(builder)` for multi-Act or `beforeAll`-shared setups. Legacy `store().seed()` in `beforeEach` + `dispose()()` in `afterAll` still works for tests that exercise the singleton port mechanism itself. In tests, prefer the explicit `await app.correlate(); await app.drain();` pair over `settle()` so cycle counts are deterministic.
- **Reaction backoff is per-worker.** `ReactionOptions.backoff` paces retries in process memory on the local `DrainController`. With N competing workers, each worker only paces its own attempts, but the shared `retry_count` on the stream watermark climbs across all of them — so `blockOnError` fires up to N× sooner than the strategy suggests. Intentional: transient per-worker faults recover faster, poison messages get quarantined sooner. For cross-worker pacing on very long backoffs, forward to an external bus rather than holding leases. The effective backoff floor is `max(configured, leaseMillis)` because the controller holds the lease during the window. See [error-handling.md § Backoff](docs/docs/concepts/error-handling.md).
- **Lanes give intra-process responsiveness, not just deployment shapes.** `.withLane({...})` spawns one `DrainController` per declared lane plus the implicit `"default"`. `Act._drainAll` runs every controller's `drain()` in parallel via `Promise.all`, so a slow handler holding the slow lane's lease doesn't block the fast lane's claim — even in a single process with no `ACT_ONLY_LANES`. Per-lane `LaneConfig.leaseMillis`/`streamLimit`/`cycleMs` override caller-passed `DrainOptions` (the whole point of `withLane({leaseMillis: 30_000})` is to give the lane its own budget — a caller-level override would erase it). Lane assignments must agree across reactions targeting the same `(target, source)` — disagreement throws at `classifyRegistry`, because lanes have no `max()` merge analogous to priority. Re-laning is restart-driven: `subscribe()` UPSERTs each stream's lane on every call; online re-laning while workers hold leases is not supported. See [concepts/configuration.md § Lanes](docs/docs/concepts/configuration.md#lanes) and [guides/production-checklist.md § Sizing lanes](docs/docs/guides/production-checklist.md).

## Code Organization (pointers, not duplication)

Source-of-truth for what lives where:

- `libs/act/src/state-builder.ts`, `slice-builder.ts`, `projection-builder.ts`, `act-builder.ts` — public builder APIs
- `libs/act/src/internal/event-sourcing.ts` — `load()`, `action()`, `snap()`
- `libs/act/src/internal/correlate-cycle.ts`, `drain-cycle.ts`, `settle.ts` — reaction pipeline
- `libs/act/src/internal/close-cycle.ts` — close-the-books orchestration
- `libs/act/src/ports.ts` + `libs/act/src/adapters/` — port singletons and in-memory defaults
- `libs/act-pg/src/PostgresStore.ts`, `libs/act-sqlite/src/SqliteStore.ts` — production adapters
- `libs/act/src/types/` — public type contracts (`Store`, `Cache`, `Logger`, `Snapshot`, errors)

## Development Workflow

- Strict TypeScript everywhere — type-check before pushing
- Pre-commit hooks run lint/format; pre-push runs the full test suite (don't bypass with `--no-verify` unless asked)
- Use Zod schemas for all runtime validation
- Never modify event data structures in place — evolve via versioned event names
- Keep state machines focused; split concerns into separate slices
- Adding a feature to core: update `libs/act/src/types/`, implement, test, demo in an example, ensure all three stores (InMemory/Postgres/Sqlite) support it
- Adding a new `/libs` package: see [contributing-new-package.md](docs/docs/guides/contributing-new-package.md) — **seed a baseline tag before the first merge** or semantic-release defaults to `1.0.0`
- **Respecting the stability charter.** The public API is covered by [STABILITY.md](STABILITY.md). Before changing any of the surfaces below, decide whether the change is **additive** (new optional method, new optional field, new event name) or **breaking** (rename, removal, narrowed type, changed semantics). Additive changes are fine in any release; breaking changes require a `BREAKING CHANGE:` commit footer that drives a major version bump and a written migration note in `RELEASE_NOTES_*.md` or the changelog. If you're not sure which category your change falls into, stop and ask. Files holding charter-covered surface:
  - `libs/act/src/builders/{act,state,slice,projection,…}-builder.ts` — fluent builder DSL
  - `libs/act/src/act.ts` — the `IAct` interface (`do`, `load`, `query`, `query_array`, `drain`, `settle`, `correlate`, `reset`, `close`) and lifecycle event names/shapes
  - `libs/act/src/types/ports.ts` — `Store`, `Cache`, `Logger` interfaces
  - `libs/act/src/types/index.ts` (and what it re-exports) — public type surface
  - `libs/act/src/ports.ts` — the public port singletons (`store()`, `cache()`, `log()`, `dispose()`, etc.) and `SNAP_EVENT`/`TOMBSTONE_EVENT` constants

  Out of scope for the charter — change freely: anything in `libs/act/src/internal/`, performance characteristics, log formats, adapter implementation details outside the contract.

- **Changing a port interface (Store, Cache, Logger).** When you add, remove, or change a method on a port in `libs/act/src/types/ports.ts`, you must also update the matching `runStoreTck` / `runCacheTck` / `runLoggerTck` in `libs/act-tck/src/`. The TCK is the executable contract — adapters validate themselves against it. Rules:
  1. Add or update cases in `libs/act-tck/src/{store,cache,logger}-tck.ts`.
  2. If the method is optional, add a flag to the matching `Capabilities` type and gate the new tests on it so existing adapters keep passing until they opt in.
  3. Update the `docs/docs/guides/writing-a-*.md` walkthrough for that port (if it exists yet).
  4. Run the TCK against every in-tree adapter (InMemory, act-pg, act-sqlite, act-pino).
  Example: `Store.query_stats(input, options)` from [#639](https://github.com/Rotorsoft/act-root/issues/639) landed as a required method (not capability-gated — every adapter implements it). The TCK gained a `describe("query_stats", …)` block in `store-tck.ts` in lockstep with the port change.

### Pre-handoff workflow (mandatory before "ready for review" / PR)

Branch work isn't done until `/release-check` passes cleanly. Per-slice `pnpm test -F <pkg>` during development is fine; the final gate is **not optional**.

Sequence at the end of a feature branch:

1. `/release-check` — runs typecheck + tests + 100% coverage + lint + build + charter-diff in parallel. See [.claude/commands/release-check.md](.claude/commands/release-check.md).
2. If coverage < 100% on any metric: run `/coverage` to see the uncovered lines, then write the fault-injection test or restructure the code to remove the branch. See `feedback_full_coverage.md` in memory and the patterns in `libs/act-pg/test/store.error.spec.ts` / `libs/act-sqlite/test/store.error.spec.ts`.
3. **For substantive tickets** (anything that touched `libs/act/src/`, added a new public method, changed semantics, or migrated a callsite to a new primitive): run `/book-note <ticket-slug>` and write the narrative essay. See [.claude/commands/book-note.md](.claude/commands/book-note.md) and `book/README.md`. Skip only for pure chore/deps/docs PRs. The essay captures the *why* and the *rejected designs* — the part that won't be visible from the diff once it's merged. **Do this BEFORE opening the PR**, so the book entry lands with the code.
4. **Doc audit — any PR that changes a public surface, renames a method, migrates a callsite to a new primitive, or alters described semantics must update the relevant docs in the same PR.** Run the stale-reference grep:
   ```bash
   grep -rln "<old-name-or-shape>" docs/docs book CLAUDE.md libs/*/README.md
   ```
   Hits get fixed inline; **do not** leave them for a "follow-up PR." Specifically:
   - **Port changes** (`Store` / `Cache` / `Logger`) → check `docs/docs/architecture/extension-points.md` and the matching `docs/docs/guides/writing-a-{store,cache,logger}.md`. The method-list snippet in extension-points goes stale every time the interface gains, loses, or renames a method.
   - **Orchestrator / `Act` API changes** → check `docs/docs/concepts/` (especially `event-sourcing.md`, `error-handling.md`, `state-management.md`).
   - **Internal subsystem refactors** (close-cycle, drain, settle, correlate) → check the matching `docs/docs/architecture/` page. Pseudocode and ASCII pipeline diagrams there often spell out the *old* shape ("Phase X: query backward, limit:1") — grep for the literal description, not just the method name.
   - **Lifecycle event additions/changes** → check `docs/docs/concepts/error-handling.md` and `docs/docs/guides/production-checklist.md`.
   The pattern that catches this: the PR's commit message says "we changed X" — every place that *describes* X in the docs needs the same update. Treat the docs as part of the public surface.
5. Only then: announce "ready for review", show the diff summary, offer to open a PR via `/pr`.

**Don't invent ad-hoc gates.** Running `pnpm typecheck` or eyeballing `pnpm test` output once doesn't substitute for the gate. Reach for the slash command first; narrow to ad-hoc tooling only for targeted debugging mid-development.

Why this exists: each step closes a failure mode that has actually shipped. The gate (step 1) caught zero issues during development of ACT-639's eight slices because per-slice tests were run ad-hoc — the merge gate verifies the full matrix (typecheck against the workspace, lint across changed files, build of every adapter, 100% coverage including newly-added defensive branches). The book-note step (step 3) exists in narrative form for the same reason: ACT-639's PR almost shipped without one because the workflow didn't enforce it, and once a PR merges the reasoning behind rejected designs lives only in the author's head until it's lost. The doc-audit step (step 4) exists because the same #639 PR shipped without updating `docs/docs/architecture/close-cycle.md` (which still described the old per-stream query pattern) and `docs/docs/guides/writing-a-store.md` (which still referred to an earlier "planned" name for the same primitive) — both required follow-up PRs that should have been part of the original change.

### Documentation discipline

- **READMEs** show current patterns and strategies — not historical benchmarks
- **`PERFORMANCE.md`** tracks evolution with per-optimization before/after numbers
- New optimization → benchmark goes in `PERFORMANCE.md`, README links to it
- Deep reference goes in `docs/docs/` (Docusaurus), procedural app-building guidance in `.claude/skills/scaffold-act-app/`, contributor workflow in `docs/docs/guides/`

## Rules for contributing to this repo

Durable workflow rules the AI assistant follows when working on the framework itself. Project-management concerns, not framework API guidance — for the latter, see "Safety-critical one-liners" above.

- **100% coverage on every metric is a merge gate.** `pnpm test` must report 100% statements / branches / functions / lines before a PR ships. No exceptions for "defensive `?? 0` fallback" or "rollback path that mirrors an existing untested branch." Fault-injection patterns exist (see `libs/act-pg/test/store.error.spec.ts` and `libs/act-sqlite/test/store.error.spec.ts`) — use them. A 99.95% PR is not ready. **No `/* c8 ignore */` or `/* v8 ignore */` markers in `libs/act/src/`, `libs/act-pg/src/`, `libs/act-sqlite/src/`, `libs/act-tck/src/`, or any adapter under `libs/act-*/src/`.** If a defensive branch can't be hit, either remove it (the contract guarantees the value) or write a test that hits it via private-state mutation. The `act-diagram` CLI is the only exception — its CLI surface guards genuine runtime conditions tests can't exercise (TTY checks, FS race conditions, non-Error throws) and uses ignore markers with inline justifications.
- **Integration helpers live in separate packages, never in core.** HTTP delivery, message-bus forwarders, webhook signers, etc. go in their own `@rotorsoft/act-*` package (precedent: `act-http`, `act-sse`, `act-pino`, `act-pg`, `act-sqlite`, `act-tck`, `act-patch`). Core stays governed by `STABILITY.md`.
- **No manual version bumps.** Semantic-release owns the `version` field in `package.json`. The only manual version event is seeding the baseline `0.0.0` tag when adding a new package. Manual bumps create diffs that conflict with the auto-bump commit.
- **Don't modify working code without explicit approval.** Propose changes first when the user hasn't asked for code. Refactors-while-you're-here are the most common way to expand the blast radius of a small request.
- **Conventional-commit subject must be lowercase.** `feat(act): add foo` not `feat(act): Add foo`. The commitlint hook will reject otherwise.
- **Never `--no-verify` or `--no-gpg-sign`.** The pre-commit hook runs lint-staged; the pre-push hook runs tests on master. Bypassing either ships unverified work. If a hook fails, fix the underlying issue.
- **PR auto-close uses GitHub numbers, not project keys.** `Closes #735` (auto-closes on merge), not `Closes ACT-604` (doesn't). Project keys go in the PR title and body for searchability.
### Naming conventions

The codebase uses two distinct casings. Which one you pick is determined by **whether the identifier is on the public surface or not** — there is no third "shifting style by context" option.

**Public — camelCase. This is the convention, not a legacy carve-out.**

Anything reachable from a package's `src/index.ts` (or subpath `index.ts` for `act-http`/`act-ops`) is camelCase:

- Exported functions: `verifyWebhook`, `applyPatchMessage`, `withIdempotency`, `runStoreTck`, `webhookMiddleware`, `minSafeTtl`, `extractIdempotencyKey`, `checkWebhook`.
- Public type fields: `IAct.forget` return `{eventCount}`, `forgotten` event `eventCount`, `StateNode.varName`, `EventNode.hasCustomPatch`, `WebhookConfig.timeoutMs`/`idempotencyKey`, `HttpDeliveryErrorInit.responseBody`, `VerifyOptions.maxAgeSeconds`, `RetryProfile.safetyFactor`, `Projection.batchHandler`, `QueryStreamsResult.maxEventId`, `InMemoryIdempotencyStore` options `ttlMs`/`maxEntries`/`retryProfile`.
- ActOptions / RetryOptions / ReactionOptions / Backoff / DrainOptions / SettleOptions / LaneConfig fields: `maxRetries`, `blockOnError`, `baseMs`, `maxMs`, `jitter`, `strategy`, `leaseMillis`, `eventLimit`, `streamLimit`, `cycleMs`, `debounceMs`, `maxSubscribedStreams`, `onlyLanes`, `settleDebounceMs`, `maxPasses`, `expectedVersion`, `reactingTo`, `asOf`, `maxSize`.
- Builder methods: `withState`, `withProjection`, `withReaction`, `withActor`, `withLane`, `withSlice`.
- Top-level factories: short single-word lowercase — `act`, `state`, `slice`, `projection`, `sensitive`, `webhook`, `receiver`, `broadcast`.
- Public class names + types — PascalCase always: `StateNode`, `BroadcastChannel`, `InMemoryStore`, `ConsoleLogger`, `RetryProfile`, `WebhookConfig`, `IdempotencyStore`. Suffix with `XxxOptions` / `XxxResult` / `XxxConfig` when applicable.

**Internal — short snake_case, no exceptions:**

- Internal helper functions: `run_close_cycle`, `classify_registry`, `compute_backoff_delay`, `build_handle`, `merge_event_register`, `current_version_of`.
- Local variables: `event_to_state`, `last_event_name`, `stream_info`, `raw_body`, `headers_bag`.
- Function parameters: TS doesn't enforce parameter names as part of the public contract (callers pass positional args), so parameters are snake_case even on public method signatures — `event_name`, `state_name`, `skip_validation`.
- Private/protected class fields and methods: `_snake_case` with underscore prefix — `_drain_controllers`, `_reactive_events`, `_arm_all`, `_wire_notify`, `_max_event_id_by_stream`.
- Internal type fields (types not re-exported through any `src/index.ts`): `Classification.static_targets`, `HandleResult.next_attempt_at`, `AuditPass.on_event`, `SettleDeps.on_settled`.
- Grouping prefixes/postfixes when several related identifiers share a structural role: `pii_*`, `make_*`, `is_*`, `compute_*`, `*_by_stream`.

**Parameter properties are banned** by `erasableSyntaxOnly`: declare each field explicitly above the constructor and assign in the body. Constructor parameter names stay camelCase (matches the external call site); rename to `_snake_case` only on the assignment to the field.

**The boundary is enforced mechanically** by `runStabilityTck` from `@rotorsoft/act-tck`. Every package has a `test/stability.spec.ts` that snapshots the source text of every declared entry point plus its transitive relative re-exports. Any rename / removal / signature change on the public surface shows up as a snapshot diff in the PR. New packages opt in by adding `@rotorsoft/act-tck` as a devDep + project reference and dropping in their own `stability.spec.ts`.

## Troubleshooting

See [error-handling.md](docs/docs/concepts/error-handling.md) — covers `ValidationError`, `InvariantError`, `ConcurrencyError`, `StreamClosedError`, `NonRetryableError`, the retry pattern, blocked streams, per-reaction options, recovery via `app.unblock` / `app.blocked_streams`, and debugging (logging, lifecycle events, `query_array`/`query_streams` introspection).

For UI/frontend changes, start the dev server and exercise the feature in a browser before reporting done — type-check and tests verify code correctness, not feature correctness.

## Claude Code configuration

This repo uses Claude Code's hooks, slash commands, and subagents. See [`.claude/README.md`](.claude/README.md) for the full overview, end-to-end workflow examples, and tuning tips.

Quick reference:

- **Hooks** auto-typecheck files you edit, summarize work-in-progress state on turn end, and inject branch/dirty-file context on every prompt.
- **Slash commands**: `/pr`, `/release-check`, `/charter-diff`, `/coverage`, `/book-note`, `/scaffold-package`.
- **Subagents**: `act-code-reviewer` (charter-aware), `act-test-author` (TCK + fault-injection patterns), `act-doc-writer` (project voice).
- **Skill**: `scaffold-act-app` for translating specs into a working monorepo.

The typical "ticket → PR" flow: implement → `/coverage` → `act-code-reviewer` (pre-PR) → `/charter-diff` (if touched) → `/pr <issue#>`. The hooks fill the gap between "I think it's done" and "it is done."
