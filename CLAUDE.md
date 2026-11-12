# CLAUDE.md

Instructions for Claude Code in this repository, for two jobs: **fixing and extending the framework**, and **bootstrapping Act apps** (the `scaffold-act-app` skill). Public documentation for people lives in `docs/` (the docs site and landing page), not here; this file points into it.

## Before you start

This file is auto-loaded into context — that is not the same as having read it. Before drafting a slice plan or making the first edit, deliberately consult:

1. **Working on a branch** — `git branch --show-current` should not return `master` (or `main`). If it does, create a feature branch first (`act-<issue>-<slug>`); never accumulate edits or commits on master.
2. **Development Workflow** below — changing a port, the pre-handoff workflow, the doc audit. If a slice touches `libs/act/src/types/ports.ts`, updating `libs/act-tck/src/` is part of the same slice, not a follow-up.
3. **Rules for contributing** below — 100% coverage, no manual version bumps, integration helpers in separate packages, no `--no-verify`.
4. **Safety-critical one-liners** — re-skim the ones relevant to the file you're about to change.
5. **Code rules in `.claude/rules/`** — [`naming.md`](.claude/rules/naming.md) and [`config-validation.md`](.claude/rules/config-validation.md) load on their own once you read or edit a matching file. Before creating a new file under `libs/`, `packages/`, `recipes/` or `test/`, read them first.

## Overview

Act is an event sourcing + CQRS framework for TypeScript, built around DDD aggregates and reaction-driven workflows: **Actions → {State} ← Reactions**.

## Project Structure

pnpm monorepo:

- **`/libs`** — framework libraries
  - `@rotorsoft/act` — core event sourcing framework
  - `@rotorsoft/act-pg` — PostgreSQL adapter (production)
  - `@rotorsoft/act-sqlite` — SQLite/libSQL adapter (embedded/single-node)
  - `@rotorsoft/act-patch` — immutable deep-merge patch utility
  - `@rotorsoft/act-http` — `webhook`, `receiver`, `sse`, and APIs generated from the registry (`trpc`, `hono`, `openapi`)
  - `@rotorsoft/act-pino` — pino-backed `Logger` adapter
  - `@rotorsoft/act-notify` — `withBroker(store, broker)`: cross-process wakeups over Redis
  - `@rotorsoft/act-otel` — Prometheus metrics bridge, `instrument(app)`; leaf package, core stays metrics-free
  - `@rotorsoft/act-crypto` — AES-256-GCM envelope encryption for adapters; leaf package, core doesn't depend on it
  - `@rotorsoft/act-ops` — receiver-side idempotency and the receiver port; no dependency on `@rotorsoft/act`
  - `@rotorsoft/act-tck` — Test Compatibility Kit for Store/Cache/Logger ports
  - `@rotorsoft/act-diagram` — domain-model diagram (React UI) plus the `act` contracts CLI
- **`/packages`** — examples: `calculator`, `wolfdesk` (ticketing), `server` + `client` (tRPC + React), `inspector` (`@rotorsoft/act-inspector`, an event-store observatory)
- **`/recipes`** — operator playbooks for the edges: scaling, close-the-books, archival, partitioning, observability, timers. Start at [recipes/README.md](recipes/README.md).

## Common Commands

```bash
pnpm install          # install
pnpm build            # build all packages
pnpm test             # run all tests with coverage
pnpm check:stability  # public-surface snapshot (after pnpm build; -u to update)
pnpm typecheck        # tsc --noEmit
pnpm lint / lint:fix  # biome
pnpm clean / scrub    # build artifacts / also node_modules

pnpm dev:calculator   # run examples (also dev:wolfdesk, dev:http)

vitest                                                # watch mode (from the REPO ROOT)
pnpm -F calculator test                               # one package
npx vitest run packages/calculator/test/preconditions.spec.ts   # one file

pnpm act [dir] [-q Name]   # contracts explorer
```

## Important Constraints

- **Node ≥ 22.23.4** (CI, docs and the perf image run Node 26; a weekly `node-compat` job tests 22 and 24), **pnpm ≥ 12.18.0** (not npm/yarn)
- **TypeScript 7** (`tsc` is the native binary) everywhere except the **`docs` package, which stays on TS 6** until typedoc supports TS 7
- Strict mode everywhere; ESM only (`"type": "module"`, `.js` import extensions)
- All actions, events and state require Zod schemas; all actions need actor context (`{ id, name }`)
- Events are immutable — evolve via [versioned event names](docs/docs/architecture/event-schema-evolution.md)
- Public API stability is governed by [STABILITY.md](STABILITY.md) — read before changing any builder API, `IAct` method, `Store`/`Cache` contract, lifecycle event, or public type export

## Where to find what

- **Building an Act app:** the `scaffold-act-app` skill owns spec parsing, state/slice/projection design, layout, tRPC API, React client, SSE and tests.
- **Framework reference:** the public docs in `docs/docs/` — `concepts/` (builders, event sourcing, configuration, errors, testing, real-time), `architecture/` (concurrency, cache and snapshots, correlation and drain, close cycle, extension points, design decisions), `guides/` (2.x migration, production checklist, rules across streams, external integration, generated APIs, new packages, TCK conformance, diagrams, flow animations). Find a page by topic with `rg -l <topic> docs/docs`.
- **Before changing runtime behavior:** [behavior-contracts.md](docs/docs/architecture/behavior-contracts.md) (each documented guarantee and its test) and [design-decisions.md](docs/docs/architecture/design-decisions.md) (deliberate non-goals).
- **Performance evidence:** `libs/act/PERFORMANCE.md` and `libs/act-pg/PERFORMANCE.md`. Benchmarks run on real adapters (act-pg on port 5431, or act-sqlite), in that adapter's `bench/`; InMemory is a baseline at most.

## Safety-critical one-liners

Easy to get subtly wrong. Read the linked doc before editing related code.

- **Cross-process reactions:** call `store(adapter)` before `act()...build()`; late injection silently does nothing (a scoped Act binds `options.scoped.store`). [cross-process-reactions](docs/docs/architecture/cross-process-reactions.md)
- **Scoped ports:** `ActOptions.scoped` takes `store` and `cache` together; a cache shared across stores collides on stream keys. [extension-points § Scoped ports](docs/docs/architecture/extension-points.md#scoped-ports-per-act)
- **Projection rebuild:** use `app.reset(targets)`, never `store().reset(targets)`, or a settled app skips the replay. [event-sourcing § Projection Rebuild](docs/docs/concepts/event-sourcing.md#projection-rebuild)
- **Blocked streams:** `app.unblock` resumes at the watermark; `app.reset` replays everything (on a webhook, every delivery again). A stream whose lease is always lost blocks too: fix `leaseMillis`. [error-handling § Blocked Streams](docs/docs/concepts/error-handling.md#blocked-streams)
- **`NonRetryableError`** blocks the stream at once, but never overrides `blockOnError: false`. [error-handling § Non-retryable errors](docs/docs/concepts/error-handling.md#non-retryable-errors)
- **Windowed close prunes, it does not retire:** it deletes only below the closest safe snapshot; `keep` needs `.snap(...)` and is in days, never ms, seconds or minutes. [close-policies](docs/docs/guides/close-policies.md)
- **Layering is enforced by `libs/act/test/architecture.spec.ts`:** `internal/` receives what it needs and never reaches for ambient state; `scoped.ts` owns every `AsyncLocalStorage`. If a rule blocks you, inject the thing; don't widen the rule.
- **`reactingTo` is auto-injected** inside reaction handlers; pass it only to override. [state-management § Auto-injected `reactingTo`](docs/docs/concepts/state-management.md#auto-injected-reactingto)
- **Business rules are preconditions; invariants are the state schema.** A rule goes in `.requires([...])` and refuses with `PreconditionError`; what must hold after every action goes in the state's Zod schema. [state-management § Preconditions](docs/docs/concepts/state-management.md#preconditions)
- **Rules across streams are `.loads`:** an event listed on a load is appended to that stream in the same commit, guarded by its version at load; a load without events is an unguarded read. One store only, and never a sensitive value in a stream name (use an HMAC). [rules-across-streams](docs/docs/guides/rules-across-streams.md)
- **One fold, before the commit (the decider rule):** reducers see `id` −1 during an action, so read `data` and `version`; the final state is checked once against the state schema. [state-management § What an action checks](docs/docs/concepts/state-management.md#what-an-action-checks-in-order)
- **Single-key records:** `state({})`, a state's `.on({})` and a projection's `.on({})` take exactly one key; `.emits({})` takes any number.
- **Cross-slice event schemas:** two partials declaring the same event must share one Zod schema instance. [state-management § Cross-slice event schemas](docs/docs/concepts/state-management.md#cross-slice-event-schemas--reference-identity)
- **`_v<n>` event names are load-bearing:** adding `Foo_v2` deprecates `Foo`, and a static `.emit("Foo")` then throws at build. [event-schema-evolution](docs/docs/architecture/event-schema-evolution.md#the-versioning-convention-is-the-deprecation-signal-act-403)
- **Run vitest from the repo root:** from a package directory a spec can pass against stale `dist/`.
- **Tests:** use `fixture(builder)` (`sandbox` for several Acts). To walk the pipeline, build with `autoSettle: false` and call `await app.correlate(); await app.drain();`; otherwise wait for the outcome. [testing](docs/docs/concepts/testing.md)
- **Backoff is a persisted per-stream schedule:** every worker honors it, and a stream blocks after `maxRetries + 1` attempts. [error-handling § Backoff](docs/docs/concepts/error-handling.md#backoff)
- **Lanes:** one drain controller per lane, run in parallel; every reaction to one target must agree on its lane; re-laning takes a restart. [configuration § Lanes](docs/docs/concepts/configuration.md#lanes)

## Code Organization

- `libs/act/src/builders/` — public builder APIs
- `libs/act/src/internal/event-sourcing.ts` — `load()`, `action()`, `snap()`
- `libs/act/src/internal/correlate-cycle.ts`, `drain-cycle.ts`, `reaction-dispatch.ts`, `settle.ts` — reaction pipeline; `close-cycle.ts` — close-the-books
- `libs/act/src/ports.ts` + `libs/act/src/adapters/` — port singletons and in-memory defaults
- `libs/act-pg/src/postgres-store.ts`, `libs/act-sqlite/src/sqlite-store.ts` — production adapters
- **Three layers, by audience:** `types/` declares every public type and contract value (errors and signals, schemas, sentinels, defaults); the public runtime modules (`act.ts`, `builders/`, `adapters/`, `adapter.ts`, `ports.ts`, `config.ts`, `csv.ts`, `utils.ts`, `sensitive.ts`, `test/`) implement them and declare no public types; `internal/` is private, never re-exported and never imported by `types/`. The root `index.ts` lists every runtime name it exports, and `adapter.ts` (`@rotorsoft/act/adapter`, the rules a store calls) imports only from `types/`. `architecture.spec.ts` enforces all of it.

## Development Workflow

- Adding a feature to core: update `libs/act/src/types/`, implement, test, demo in an example, and support it in all three stores (InMemory/Postgres/Sqlite).
- Adding a `/libs` package: [contributing-new-package.md](docs/docs/guides/contributing-new-package.md) — **seed a baseline tag before the first merge** or semantic-release defaults to `1.0.0`.
- **Stability charter:** decide whether a public change is additive or breaking ([STABILITY.md](STABILITY.md)); breaking needs a `BREAKING CHANGE:` footer and a migration note. If unsure, ask. Covered: everything an entry point exports ([STABILITY.md § Covered by semver](STABILITY.md#covered-by-semver)); `pnpm check:stability` shows a change to it as a snapshot diff. **New public surface needs an RFC** ([STABILITY.md § Adding new covered surface](STABILITY.md#adding-new-covered-surface)).
- **Changing a port interface (Store, Cache, Logger)** updates the matching TCK in `libs/act-tck/src/` in the same slice: [CONTRIBUTING.md § Changing a port interface](CONTRIBUTING.md#changing-a-port-interface).
- **Pre-handoff (mandatory before a PR is ready):** run `/release-check` — the snapshot, doc-audit and lint steps CI can't decide, then every CI check passed or rightly skipped. In the same PR, fix every doc that describes what changed (grep for the old name or shape) and give every new runtime claim in the docs a test and a [behavior-contract](docs/docs/architecture/behavior-contracts.md) row. [CONTRIBUTING.md § Pre-handoff workflow](CONTRIBUTING.md#pre-handoff-workflow).
- **Documentation discipline:** READMEs show current patterns, not benchmarks; deep reference goes in `docs/docs/`, app-building guidance in `.claude/skills/scaffold-act-app/`. Every ` ```ts ` block in `docs/docs/**` is compiled in CI (`pnpm -F docs check:snippets`): a snippet is a self-contained program or carries a `no-check` marker ([docs/scripts/README.md](docs/scripts/README.md)).

## Rules for contributing to this repo

- **100% coverage on every metric is a merge gate**, with no exceptions for defensive fallbacks. **No `/* c8 ignore */` or `/* v8 ignore */` in any `libs/act*/src/`** (the `act-diagram` CLI is the only exception, with inline justifications). An unreachable branch is removed, or hit with a fault-injection or private-state test (`libs/act-pg/test/store.error.spec.ts`, `libs/act-sqlite/test/store.error.spec.ts`).
- **Every API built on Act is end-to-end type safe.** A wrapper (`trpc`, `hono`, `sse`, …) carries each action's payload and `Snapshot[]` result to the client, inferred from the app. A route typed `any`/`unknown`, or a test that casts a wrapper's result, is a wrapper defect; a new wrapper ships with a type-level test (`libs/act-http/test/typed-api.spec.ts`).
- **Integration helpers live in separate packages, never in core** (HTTP delivery, bus forwarders, signers → their own `@rotorsoft/act-*`).
- **No manual version bumps.** Semantic-release owns `version`; the only manual event is seeding a new package's `0.0.0` tag.
- **Don't modify working code without explicit approval.** Propose first when the user hasn't asked for code.
- **Conventional commits** (`<type>(<scope>): <subject>`; feat, fix, docs, style, refactor, test, chore; scope is the package). The subject starts lowercase and never with a type name; identifiers after the first word keep their case.
- **Never `--no-verify` or `--no-gpg-sign`.** If a hook fails, fix the cause.
- **PR auto-close uses GitHub numbers:** `Closes #735`, not `Closes ACT-604`.

### Naming conventions

Exported functions, builder methods and options fields are camelCase; port methods and record fields are snake_case; exported constants `SCREAMING_SNAKE`; factories short lowercase; types PascalCase; internals short snake_case. Full rules: [`.claude/rules/naming.md`](.claude/rules/naming.md). Options bags are validated with Zod: [`.claude/rules/config-validation.md`](.claude/rules/config-validation.md).

## Troubleshooting

[error-handling.md](docs/docs/concepts/error-handling.md) covers every error type, the retry pattern, blocked streams and recovery, and debugging. For UI changes, run the dev server and exercise the feature in a browser before reporting done.

## Claude Code configuration

Committed under `.claude/`: hooks (typecheck on edit, branch context per prompt), commands (`/pr`, `/release-check`, `/scaffold-package`), subagents (`act-code-reviewer`, `act-test-author`, `act-doc-writer`) and skills (`scaffold-act-app`, `simplify-core`, `debug_wave`, `animate-act-flows`). Ticket → PR: implement → `/release-check` → `act-code-reviewer` → `/pr <issue#>`.
