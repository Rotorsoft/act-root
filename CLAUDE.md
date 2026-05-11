# CLAUDE.md

Guidance for Claude Code working in this repository. This file is the **index**: brief project meta, plus pointers into `docs/docs/` (Docusaurus, for humans) and `.claude/skills/` (for Claude when building Act apps). When in doubt, follow the link.

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
  - `@rotorsoft/act-pino` — pino-backed `Logger` adapter

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
| Adding a new `@rotorsoft/act-*` package | [docs/docs/guides/contributing-new-package.md](docs/docs/guides/contributing-new-package.md) |

### Performance evidence

Per-package `PERFORMANCE.md` files track benchmark history with before/after numbers per optimization. READMEs link to them; READMEs themselves stay narrative.

- `libs/act/PERFORMANCE.md` — drain/cache/correlate
- `libs/act-pg/PERFORMANCE.md` — Postgres-specific (incl. `notify` latency)

## Safety-critical one-liners

These are easy to get subtly wrong. Read the linked docs before editing related code.

- **Cross-process reactions:** call `store(adapter)` *before* `act()...build()` — the orchestrator wires the `notify` subscription at construction. Late injection silently does nothing. See [cross-process-reactions](docs/docs/architecture/cross-process-reactions.md).
- **Projection rebuild:** always `app.reset(targets)`, never `store().reset(targets)` directly. Only `app.reset` raises the orchestrator's drain-armed flag — without it, a settled app short-circuits and skips the replay. See [event-sourcing.md § Projection Rebuild](docs/docs/concepts/event-sourcing.md).
- **Reactions auto-inject `reactingTo`:** inside a slice handler, `app.do(...)` automatically threads the triggering event as `reactingTo`. Pass an explicit fourth argument only when overriding. See [state-management.md § Auto-injected `reactingTo`](docs/docs/concepts/state-management.md).
- **Single-key records:** `state({})`, `.on({})`, `.emits({})` accept exactly one key. Multi-key throws at runtime.
- **Tests:** `store().seed()` in `beforeEach`; `dispose()()` in `afterAll`. In tests, prefer the explicit `await app.correlate(); await app.drain();` pair over `settle()` so cycle counts are deterministic.

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

### Documentation discipline

- **READMEs** show current patterns and strategies — not historical benchmarks
- **`PERFORMANCE.md`** tracks evolution with per-optimization before/after numbers
- New optimization → benchmark goes in `PERFORMANCE.md`, README links to it
- Deep reference goes in `docs/docs/` (Docusaurus), procedural app-building guidance in `.claude/skills/scaffold-act-app/`, contributor workflow in `docs/docs/guides/`

## Troubleshooting

See [error-handling.md](docs/docs/concepts/error-handling.md) — covers `ValidationError`, `InvariantError`, `ConcurrencyError`, `StreamClosedError`, the retry pattern, blocked streams, per-reaction options, and debugging (logging, lifecycle events, `query_array`/`query_streams` introspection).

For UI/frontend changes, start the dev server and exercise the feature in a browser before reporting done — type-check and tests verify code correctness, not feature correctness.
