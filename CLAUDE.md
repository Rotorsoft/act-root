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
  - `@rotorsoft/act-http` — HTTP integrations (umbrella): `webhook` for reaction-driven POST delivery, plus an `sse` submodule that mirrors `@rotorsoft/act-sse`
  - `@rotorsoft/act-pino` — pino-backed `Logger` adapter
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
| Adding a new `@rotorsoft/act-*` package | [docs/docs/guides/contributing-new-package.md](docs/docs/guides/contributing-new-package.md) |
| Inspecting contracts with the `act` CLI | [docs/docs/guides/contracts-cli.md](docs/docs/guides/contracts-cli.md) |

### Performance evidence

Per-package `PERFORMANCE.md` files track benchmark history with before/after numbers per optimization. READMEs link to them; READMEs themselves stay narrative.

- `libs/act/PERFORMANCE.md` — drain/cache/correlate
- `libs/act-pg/PERFORMANCE.md` — Postgres-specific (incl. `notify` latency)

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
  Example: when `Store.query_heads(streams)` (#639) lands, add a `queryHeads` capability and a "returns latest event per stream, empty for unknown, respects pagination" block in `store-tck.ts`.

### Documentation discipline

- **READMEs** show current patterns and strategies — not historical benchmarks
- **`PERFORMANCE.md`** tracks evolution with per-optimization before/after numbers
- New optimization → benchmark goes in `PERFORMANCE.md`, README links to it
- Deep reference goes in `docs/docs/` (Docusaurus), procedural app-building guidance in `.claude/skills/scaffold-act-app/`, contributor workflow in `docs/docs/guides/`

## Troubleshooting

See [error-handling.md](docs/docs/concepts/error-handling.md) — covers `ValidationError`, `InvariantError`, `ConcurrencyError`, `StreamClosedError`, the retry pattern, blocked streams, per-reaction options, and debugging (logging, lifecycle events, `query_array`/`query_streams` introspection).

For UI/frontend changes, start the dev server and exercise the feature in a browser before reporting done — type-check and tests verify code correctness, not feature correctness.
