# CLAUDE.md

Guidance for Claude Code working in this repository. This file is the **index**: brief project meta, plus pointers into `docs/docs/` (Docusaurus, for humans) and `.claude/skills/` (for Claude when building Act apps). When in doubt, follow the link.

## Before you start

This file is auto-loaded into context — that is not the same as having read it. Before drafting a slice plan or making the first edit, deliberately consult:

1. **Working on a branch** — `git branch --show-current` should not return `master` (or `main`). If it does, create a feature branch first (`act-<issue>-<slug>`); never accumulate edits or commits on master.
2. **Development Workflow** — the "Changing a port interface" rule, the "Pre-handoff workflow," the doc audit step. If a slice touches `libs/act/src/types/ports.ts`, updating `libs/act-tck/src/` is part of the same slice, not a follow-up.
3. **Rules for contributing to this repo** — durable workflow rules (100% coverage gate, naming, no manual version bumps, integration helpers in separate packages, no `--no-verify`).
4. **Safety-critical one-liners** — load-bearing per-feature gotchas. Re-skim the ones relevant to the file you're about to change.
5. **Code rules in `.claude/rules/`** — [`naming.md`](.claude/rules/naming.md) and [`config-validation.md`](.claude/rules/config-validation.md) load on their own once you read or edit a matching file. Before creating a new file under `libs/`, `packages/`, `recipes/` or `test/`, read them first: a path rule loads only after a matching file is touched.

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
  - `@rotorsoft/act-http` — HTTP integrations (umbrella). `webhook` for reaction-driven POST delivery, `receiver` for inbound webhook ingestion, the `sse` subpath for incremental state broadcast (the surface once published standalone as the now-removed `@rotorsoft/act-sse`), plus the auto-generated API subpaths (`trpc`, `hono`, `openapi`) that walk a built `IAct` registry and emit one route per action — guide at [docs/docs/guides/auto-generated-api.md](docs/docs/guides/auto-generated-api.md)
  - `@rotorsoft/act-pino` — pino-backed `Logger` adapter
  - `@rotorsoft/act-notify` — hybrid notify-broker decorator: `withBroker(store, broker)` delegates every durable Store method and rides an external broker (Redis implemented, Kafka scaffolded, Loopback for tests) for cross-process wakeups only — lifts the LISTEN/NOTIFY fanout ceiling without touching durability. TCK-proven over PostgresStore
  - `@rotorsoft/act-otel` — Prometheus metrics bridge: `instrument(app)` maintains the metric set listed in its README (and the observability guide) off the lifecycle events. Leaf package — core stays metrics-free by design
  - `@rotorsoft/act-crypto` — authenticated envelope encryption (AES-256-GCM + versioned wire format) for adapters that want column-level encryption with operator-controlled keys. Leaf package — adapters depend on it, core does not.
  - `@rotorsoft/act-ops` — operational primitives (idempotency, retry budgets, poison-message classification). **Zero dep on `@rotorsoft/act`** by design — so non-Act receivers (forwarded-bus consumers, Express endpoints, queue workers) can speak the same contract without pulling in the orchestrator
  - `@rotorsoft/act-tck` — Test Compatibility Kit for Store/Cache/Logger ports
  - `@rotorsoft/act-diagram` — domain-model diagram (React UI) plus the `act` contracts CLI

- **`/packages`** — example applications
  - `calculator` — simple state machine; rebuild and close demos
  - `wolfdesk` — complex ticketing (from "Learning Domain-Driven Design")
  - `server`, `client` — tRPC + React example
  - `inspector` — `@rotorsoft/act-inspector`, an observatory to inspect, query and visualize the events in an Act store

## Common Commands

```bash
pnpm install          # install
pnpm build            # build all packages
pnpm test             # run all tests with coverage
pnpm check:stability  # public-surface snapshot (after pnpm build; -u to update)
pnpm typecheck        # tsc --noEmit
pnpm lint / lint:fix  # biome
pnpm clean            # remove build artifacts
pnpm scrub            # remove all node_modules + build artifacts

pnpm dev:calculator   # run examples
pnpm dev:wolfdesk
pnpm dev:http         # multi-transport demo (trpc + hono rest + openapi) — server + client concurrently

vitest                                                # watch mode (from the REPO ROOT)
pnpm -F calculator test                               # one package
npx vitest run packages/calculator/test/invariants.spec.ts   # one file

pnpm -F wolfdesk drizzle:migrate   # wolfdesk migrations (its tests also self-migrate)

pnpm act                                  # interactive contracts explorer (current dir)
pnpm act packages/wolfdesk                # explore a specific package
pnpm act -q TicketOpened                  # non-interactive: print one entity, exit
```

## Important Constraints

- **Node ≥ 22.23.3** (the libraries' engines floor; CI, docs and the perf image run on **Node 26**, and a weekly `node-compat` job in `conformance.yml` tests 22 and 24), **pnpm ≥ 12.8.2** (not npm/yarn)
- **TypeScript 7** (`typescript@^7.0.2`, the native Go compiler — `tsc` is the native binary) across the framework, libs, and example apps. The **`docs` package alone stays on `typescript@6`** — a documented, temporary island — because typedoc caps its `typescript` peer at `6.x` and the API-reference generation (`pnpm -F docs build:all`) can't run on TS7 yet. pnpm's per-package isolation resolves the docs symlink to its own TS6 install; the rest of the workspace hoists TS7. Revisit once typedoc supports TS7.
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
| Close-the-books phase semantics (explicit + online) | [docs/docs/architecture/close-cycle.md](docs/docs/architecture/close-cycle.md) |
| Online close-the-books policies — `.autocloses` / `.archives` | [docs/docs/guides/close-policies.md](docs/docs/guides/close-policies.md) |
| Event schema evolution (versioned event names) | [docs/docs/architecture/event-schema-evolution.md](docs/docs/architecture/event-schema-evolution.md) |
| Deliberate ES design choices & non-goals (compensation, schema evolution, projection idempotency) | [docs/docs/architecture/design-decisions.md](docs/docs/architecture/design-decisions.md) |
| Store / Cache / Logger contracts and adapters | [docs/docs/architecture/extension-points.md](docs/docs/architecture/extension-points.md) |
| Behavior-contract checklist (documented runtime guarantees → backing tests) | [docs/docs/architecture/behavior-contracts.md](docs/docs/architecture/behavior-contracts.md) |
| Production deployment checklist | [docs/docs/guides/production-checklist.md](docs/docs/guides/production-checklist.md) |
| Database-backed projections (Drizzle, batched replay) | [docs/docs/guides/projections-to-database.md](docs/docs/guides/projections-to-database.md) |
| External integration (inline `webhook` vs forwarded bus, idempotency contract, recovery) | [docs/docs/guides/external-integration.md](docs/docs/guides/external-integration.md) |
| Auto-generated API surfaces (`trpc`, `hono`, `openapi` subpaths + deployment recipes) | [docs/docs/guides/auto-generated-api.md](docs/docs/guides/auto-generated-api.md) |
| Flow animations: animated maps of an app's flows, published with the docs or exported as MP4 (`docs/flows/*.flow.json`, `animate-act-flows` skill) | [docs/docs/guides/flow-animations.md](docs/docs/guides/flow-animations.md) |
| Adding a new `@rotorsoft/act-*` package | [docs/docs/guides/contributing-new-package.md](docs/docs/guides/contributing-new-package.md) |
| Third-party adapter onboarding (TCK from a fresh repo + conformance badge) | [docs/docs/guides/tck-conformance.md](docs/docs/guides/tck-conformance.md) |
| Inspecting contracts with the `act` CLI | [docs/docs/guides/contracts-cli.md](docs/docs/guides/contracts-cli.md) |

### Operator recipes

When an Act application hits the edges (events table growing without bound, cooldowns after terminal state, regulated retention windows, partition-drop archival), the playbook lives in [`recipes/`](recipes/README.md) at the repo root — separate from `libs/` (framework code) and `docs/` (framework reference).

| Topic | File |
|---|---|
| Top-level operator landing + envelope of safe operation | [recipes/README.md](recipes/README.md) |
| Scaling decision tree (symptoms → recipe) | [recipes/scaling/README.md](recipes/scaling/README.md) |
| Close-the-books patterns (`.autocloses({...})`) | [recipes/scaling/close-the-books/README.md](recipes/scaling/close-the-books/README.md) |
| Cold-tier archival (`.archives(...)` + S3 / JSONL) | [recipes/scaling/archival/README.md](recipes/scaling/archival/README.md) |
| Scale-out by splitting stores (per-context/tenant `ActOptions.scoped`) | [recipes/scaling/split-stores/README.md](recipes/scaling/split-stores/README.md) |
| Hybrid store — event log and subscriptions on separate databases, behind one `Store` | [recipes/scaling/hybrid-store/README.md](recipes/scaling/hybrid-store/README.md) |
| Lift the LISTEN/NOTIFY fanout ceiling (act-notify + Redis) | [recipes/scaling/notify-broker/README.md](recipes/scaling/notify-broker/README.md) |
| Partitioning gating page (the "don't" page) | [recipes/scaling/partitioning/README.md](recipes/scaling/partitioning/README.md) |
| HASH-on-stream partition recipe (SQL + run.sh) | [recipes/scaling/partitioning/hash-on-stream/](recipes/scaling/partitioning/hash-on-stream/README.md) |
| RANGE-on-id (single-aggregate giants, docs only) | [recipes/scaling/partitioning/range-on-id/](recipes/scaling/partitioning/range-on-id/README.md) |
| RANGE-on-created (bulk archival via DROP PARTITION) | [recipes/scaling/partitioning/range-on-created/](recipes/scaling/partitioning/range-on-created/README.md) |
| Prometheus metrics via act-otel (alert rules + runnable scrape demo) | [recipes/observability/prometheus/README.md](recipes/observability/prometheus/README.md) |
| Temporal / timing recipes landing (one-shot vs recurring) | [recipes/temporal/README.md](recipes/temporal/README.md) |
| Recurring timers (tick-emits-next-tick over one-shot `.defer`) | [recipes/temporal/recurring-timers/README.md](recipes/temporal/recurring-timers/README.md) |

Recipe conventions: each folder has a README + optional runnable artifacts (`.sql` files using `{{schema}}` / `{{table}}` placeholders, `run.sh` wrappers, `.ts` samples that compile against the live `@rotorsoft/act` API). The framework code stays unchanged — recipes are operator playbooks, not framework features. New recipes land here when an operator hits a real wall the existing pages don't cover.

### Performance evidence

Per-package `PERFORMANCE.md` files track benchmark history with before/after numbers per optimization. READMEs link to them; READMEs themselves stay narrative.

- `libs/act/PERFORMANCE.md` — drain/cache/correlate
- `libs/act-pg/PERFORMANCE.md` — Postgres-specific (incl. `notify` latency)

**Benchmarks must run on real adapters.** InMemoryStore is the fastest possible read/write path (no I/O, no SQL planner) — measuring perf optimizations against it understates wins and ignores the index/lock/connection-pool dimensions that the production adapters live in. Every perf claim that ships in a `PERFORMANCE.md` table needs numbers from `act-pg` (port 5431 docker) or `act-sqlite`. InMemory may appear as a baseline reference, never as the primary number. New benches go in the relevant adapter package's `bench/` or `scripts/`, not just `libs/act/bench/`.

## Safety-critical one-liners

Easy to get subtly wrong. Read the linked doc before editing related code.

- **Cross-process reactions:** call `store(adapter)` before `act()...build()`; late injection silently does nothing (a scoped Act binds `options.scoped.store`). [cross-process-reactions](docs/docs/architecture/cross-process-reactions.md)
- **Scoped ports:** `ActOptions.scoped` takes `store` and `cache` together; a cache shared across stores collides on stream keys. [extension-points § Scoped ports](docs/docs/architecture/extension-points.md#scoped-ports-per-act)
- **Projection rebuild:** use `app.reset(targets)`, never `store().reset(targets)`, or a settled app skips the replay. [event-sourcing § Projection Rebuild](docs/docs/concepts/event-sourcing.md#projection-rebuild)
- **Blocked streams:** `app.unblock` resumes at the watermark; `app.reset` replays everything (on a webhook, every delivery again). A stream whose lease is always lost blocks too: fix `leaseMillis`. [error-handling § Blocked Streams](docs/docs/concepts/error-handling.md#blocked-streams)
- **`NonRetryableError`** blocks the stream at once, but never overrides `blockOnError: false`. [error-handling § Non-retryable errors](docs/docs/concepts/error-handling.md#non-retryable-errors)
- **Windowed close prunes, it does not retire:** it deletes only below the closest safe snapshot; `keep` needs `.snap(...)` and is in days, never ms, seconds or minutes. [close-policies](docs/docs/guides/close-policies.md)
- **Layering is enforced by `libs/act/test/architecture.spec.ts`:** `internal/` receives what it needs and never reaches for ambient state; `scoped.ts` owns every `AsyncLocalStorage`. If a rule blocks you, inject the thing; don't widen the rule. The spec's header explains each rule.
- **`reactingTo` is auto-injected** inside reaction handlers; pass it only to override. [state-management § Auto-injected `reactingTo`](docs/docs/concepts/state-management.md#auto-injected-reactingto)
- **Single-key records:** `state({})`, `.on({})` and `.emits({})` take exactly one key; more throws.
- **Cross-slice event schemas:** two partials declaring the same event must share one Zod schema instance; export it from a module. [state-management § Cross-slice event schemas](docs/docs/concepts/state-management.md#cross-slice-event-schemas--reference-identity)
- **`_v<n>` event names are load-bearing:** adding `Foo_v2` deprecates `Foo`, and a static `.emit("Foo")` then throws at build. [event-schema-evolution](docs/docs/architecture/event-schema-evolution.md#the-versioning-convention-is-the-deprecation-signal-act-403)
- **Run vitest from the repo root** (`pnpm test`, `pnpm -F <pkg> test`, `npx vitest run <path>`): from a package directory a spec can pass against stale `dist/`.
- **Tests:** use `fixture(builder)` (`sandbox` for several Acts). To walk the pipeline, build with `autoSettle: false` and call `await app.correlate(); await app.drain();` (a bare `drain()` after a commit finds nothing); otherwise keep the default and wait for the outcome. [testing](docs/docs/concepts/testing.md)
- **Backoff is a persisted per-stream schedule:** every worker honors it, and a stream blocks after `maxRetries + 1` attempts. [error-handling § Backoff](docs/docs/concepts/error-handling.md#backoff)
- **Lanes:** one drain controller per lane, run in parallel; every reaction to one target must agree on its lane; re-laning takes a restart. [configuration § Lanes](docs/docs/concepts/configuration.md#lanes)

## Code Organization (pointers, not duplication)

Source-of-truth for what lives where:

- `libs/act/src/builders/` (`state-builder.ts`, `slice-builder.ts`, `projection-builder.ts`, `act-builder.ts`) — public builder APIs
- `libs/act/src/internal/event-sourcing.ts` — `load()`, `action()`, `snap()`
- `libs/act/src/internal/correlate-cycle.ts`, `drain-cycle.ts`, `reaction-dispatch.ts`, `settle.ts` — reaction pipeline
- `libs/act/src/internal/close-cycle.ts` — close-the-books orchestration
- `libs/act/src/ports.ts` + `libs/act/src/adapters/` — port singletons and in-memory defaults
- `libs/act-pg/src/postgres-store.ts`, `libs/act-sqlite/src/sqlite-store.ts` — production adapters
- `libs/act/src/types/` — public type contracts (`Store`, `Cache`, `Logger`, `Snapshot`, errors)
- **Three layers, by audience:** `types/` declares every public type (and the public contract values: errors and signals, schemas, sentinels, defaults); the public runtime modules (`act.ts`, `builders/`, `adapters/`, `ports.ts`, `config.ts`, `csv.ts`, `utils.ts`, `sensitive.ts`, `test/`) implement them and declare no public types; `internal/` is private, never re-exported and never imported by `types/`. `architecture.spec.ts` enforces all three.

## Development Workflow

- Strict TypeScript everywhere — type-check before pushing
- Pre-commit hooks run lint/format, and CI runs the full suite on every push (never bypass hooks with `--no-verify`)
- Use Zod schemas for all runtime validation
- Never modify event data structures in place — evolve via versioned event names
- Keep state machines focused; split concerns into separate slices
- Adding a feature to core: update `libs/act/src/types/`, implement, test, demo in an example, ensure all three stores (InMemory/Postgres/Sqlite) support it
- Adding a new `/libs` package: see [contributing-new-package.md](docs/docs/guides/contributing-new-package.md) — **seed a baseline tag before the first merge** or semantic-release defaults to `1.0.0`
- **Respecting the stability charter.** The public API is covered by [STABILITY.md](STABILITY.md). Before changing any of the surfaces below, decide whether the change is **additive** (new optional method, new optional field, new event name) or **breaking** (rename, removal, narrowed type, changed semantics). Additive changes are fine in any release; breaking changes require a `BREAKING CHANGE:` commit footer that drives a major version bump and a written migration note in `RELEASE_NOTES_*.md` or the changelog. If you're not sure which category your change falls into, stop and ask. Files holding charter-covered surface:
  - `libs/act/src/builders/{act,state,slice,projection}-builder.ts` and their contracts in `libs/act/src/types/builders.ts` — fluent builder DSL
  - `libs/act/src/act.ts` and `libs/act/src/types/act.ts` — the `Act` orchestrator, `ActOptions`, and lifecycle event names/shapes (`IAct` lives in `types/action.ts`)
  - `libs/act/src/types/ports.ts` — `Store`, `Cache`, `Logger` interfaces
  - `libs/act/src/types/index.ts` (and what it re-exports) — public type surface
  - `libs/act/src/ports.ts` — the public port singletons (`store()`, `cache()`, `log()`, `dispose()`, etc.); the `SNAP_EVENT`/`TOMBSTONE_EVENT` constants live in `types/ports.ts`

  Out of scope for the charter — change freely: anything in `libs/act/src/internal/`, performance characteristics, log formats, adapter implementation details outside the contract.

- **Gating new public surface — write an RFC.** The charter catches *changes* to the public surface; the `rfcs/` process gates *additions* before they calcify. Any PR that adds a new public export, builder method, port method, or lifecycle event needs a one-page RFC (copy [`rfcs/0000-template.md`](rfcs/0000-template.md) → `rfcs/NNNN-<slug>.md`) capturing motivation, the surface added, alternatives considered, and stability impact. The PR template carries the checklist line; see [`rfcs/README.md`](rfcs/README.md) for what does and doesn't require one. The reviewer checks it against the stability snapshot diff; there is no CI gate.

- **Changing a port interface (Store, Cache, Logger).** When you add, remove, or change a method on a port in `libs/act/src/types/ports.ts`, you must also update the matching `runStoreTck` / `runCacheTck` / `runLoggerTck` in `libs/act-tck/src/`. The TCK is the executable contract — adapters validate themselves against it. Rules:
  1. Add or update cases in `libs/act-tck/src/{store,cache,logger}-tck.ts`.
  2. If the method is optional, add a flag to the matching `Capabilities` type and gate the new tests on it so existing adapters keep passing until they opt in.
  3. Update the `docs/docs/guides/writing-a-*.md` walkthrough for that port (if it exists yet).
  4. Run the TCK against every in-tree adapter (InMemory, act-pg, act-sqlite, act-pino).
  Example: `Store.query_stats(input, options)` from [#639](https://github.com/Rotorsoft/act-root/issues/639) landed as a required method (not capability-gated — every adapter implements it). The TCK gained a `describe("query_stats", …)` block in `store-tck.ts` in lockstep with the port change.

### Pre-handoff workflow (mandatory before "ready for review" / PR)

Run `/release-check` before calling a branch ready: it runs the snapshot, doc-audit and lint steps CI can't decide, then waits until every CI check on the PR has passed or was rightly skipped. A local test run doesn't substitute for reading CI. In the same PR, fix every doc that describes what changed (grep for the old name or shape; never a follow-up PR), give every new runtime claim in the docs a test and a [behavior-contract](docs/docs/architecture/behavior-contracts.md) row, and add a `learnings.md` entry only when the change taught something new. Steps and the doc-audit checklist: [CONTRIBUTING.md § Pre-handoff workflow](CONTRIBUTING.md#pre-handoff-workflow).

### Documentation discipline

- **READMEs** show current patterns and strategies — not historical benchmarks
- **`PERFORMANCE.md`** tracks evolution with per-optimization before/after numbers
- New optimization → benchmark goes in `PERFORMANCE.md`, README links to it
- Deep reference goes in `docs/docs/` (Docusaurus), procedural app-building guidance in `.claude/skills/scaffold-act-app/`, contributor workflow in `docs/docs/guides/`
- **Doc snippets are type-checked.** Every fenced ` ```ts ` block in `docs/docs/**` is tangled and compiled against the live `@rotorsoft/act` source in CI (`pnpm -F docs check:snippets`). A new snippet must be a self-contained program or carry a `no-check` marker on its info string if it's a deliberate fragment. See [docs/scripts/README.md](docs/scripts/README.md).

## Rules for contributing to this repo

Durable workflow rules the AI assistant follows when working on the framework itself. Project-management concerns, not framework API guidance — for the latter, see "Safety-critical one-liners" above.

- **100% coverage on every metric is a merge gate.** `pnpm test` must report 100% statements / branches / functions / lines before a PR ships. No exceptions for "defensive `?? 0` fallback" or "rollback path that mirrors an existing untested branch." Fault-injection patterns exist (see `libs/act-pg/test/store.error.spec.ts` and `libs/act-sqlite/test/store.error.spec.ts`) — use them. A 99.95% PR is not ready. **No `/* c8 ignore */` or `/* v8 ignore */` markers in `libs/act/src/`, `libs/act-pg/src/`, `libs/act-sqlite/src/`, `libs/act-tck/src/`, or any adapter under `libs/act-*/src/`.** If a defensive branch can't be hit, either remove it (the contract guarantees the value) or write a test that hits it via private-state mutation. The `act-diagram` CLI is the only exception — its CLI surface guards genuine runtime conditions tests can't exercise (TTY checks, FS race conditions, non-Error throws) and uses ignore markers with inline justifications.
- **Integration helpers live in separate packages, never in core.** HTTP delivery, message-bus forwarders, webhook signers, etc. go in their own `@rotorsoft/act-*` package (precedent: `act-http`, `act-pino`, `act-pg`, `act-sqlite`, `act-tck`, `act-patch`). Core stays governed by `STABILITY.md`.
- **No manual version bumps.** Semantic-release owns the `version` field in `package.json`. The only manual version event is seeding the baseline `0.0.0` tag when adding a new package. Manual bumps create diffs that conflict with the auto-bump commit.
- **Don't modify working code without explicit approval.** Propose changes first when the user hasn't asked for code. Refactors-while-you're-here are the most common way to expand the blast radius of a small request.
- **Conventional-commit subject starts lowercase; identifiers after the first word keep their case.** `feat(act): add foo` not `feat(act): Add foo`, and `fix(act): make InMemoryStore drop ...` keeps the type name as written. The commitlint hook rejects only a capitalized first word, so never start the subject with a type name.
- **Never `--no-verify` or `--no-gpg-sign`.** The pre-commit hook runs lint-staged and the commit-msg hook runs commitlint; bypassing them ships unverified work. If a hook fails, fix the underlying issue.
- **PR auto-close uses GitHub numbers, not project keys.** `Closes #735` (auto-closes on merge), not `Closes ACT-604` (doesn't). Project keys go in the PR title and body for searchability.

### Naming conventions

Anything reachable from a package's `src/index.ts` (or a subpath `index.ts`) is camelCase; top-level factories are short single-word lowercase (`act`, `state`, `webhook`) and types are PascalCase (`XxxOptions` / `XxxResult` / `XxxConfig`). Everything internal is short snake_case, including function parameters, with `_snake_case` for private fields. **Parameter properties are banned** by `erasableSyntaxOnly`: declare each field and assign it in the constructor. `pnpm check:stability` snapshots the public declarations, so a rename shows up as a diff. Examples: [`.claude/rules/naming.md`](.claude/rules/naming.md).

### Config-validation schemas

Every options bag an entry point takes (`act().build()`, `openapi(app, ...)`, ...) is validated with Zod, never with hand-written range checks: an internal `<Type>OptionsSchema`, a `resolve<Type>Config` resolver, `DEFAULT_*` constants. Act-core bags live in `libs/act/src/internal/config.ts`. Validation rejects `NaN`/`±Infinity`/nonsense but never newly rejects a value that works today. The full table: [`.claude/rules/config-validation.md`](.claude/rules/config-validation.md).

## Troubleshooting

See [error-handling.md](docs/docs/concepts/error-handling.md) — covers `ValidationError`, `InvariantError`, `ConcurrencyError`, `StreamClosedError`, `NonRetryableError`, the retry pattern, blocked streams, per-reaction options, recovery via `app.unblock` / `app.blocked_streams`, and debugging (logging, lifecycle events, `query_array`/`query_streams` introspection).

For UI/frontend changes, start the dev server and exercise the feature in a browser before reporting done — type-check and tests verify code correctness, not feature correctness.

## Claude Code configuration

This repo uses Claude Code's hooks, slash commands, subagents and skills, all committed under `.claude/` so every session starts with the same setup.

Quick reference:

- **Hooks** auto-typecheck files you edit and inject branch/dirty-file context on every prompt.
- **Slash commands**: `/pr`, `/release-check`, `/scaffold-package`.
- **Subagents**: `act-code-reviewer` (charter-aware), `act-test-author` (TCK + fault-injection patterns), `act-doc-writer` (project voice).
- **Skills**: `scaffold-act-app` (build an app on Act), `simplify-core` (the simplicity review), `debug_wave` (adversarial bug hunting), `animate-act-flows` (animated flow map of an app).

The typical "ticket → PR" flow: implement → `/release-check` → `act-code-reviewer` (pre-PR) → `/pr <issue#>`. The hooks fill the gap between "I think it's done" and "it is done."
