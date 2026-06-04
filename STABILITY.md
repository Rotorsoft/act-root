# Stability Charter

Act has been used in production with a public API that hasn't regressed in months. Every breaking change has been a deliberate version-bump preface, not an accident. This document is the explicit contract: what semver protects, what it doesn't, and how we evolve in each category.

> **Status:** This charter takes effect with the **1.0** release, which is gated on completion of [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1). The current 0.x line already follows it in spirit — treat anything listed under "Covered" as stable in practice today, and anything under "Not covered" as subject to change.

## Covered by semver

Breaking changes to anything in this list require a **major** version bump and an entry in the relevant `CHANGELOG.md`.

### Builder API

The fluent surfaces exported from `@rotorsoft/act`:

- `state(...)` — including `.init`, `.emits`, `.patch`, `.on` (with optional `ActionOptions` second argument for per-action retry policy), `.given`, `.emit`, `.snap`, `.build`
- `slice(...)` — including `.actions`, `.given`, `.build`
- `projection(...)` — including `.from`, `.on`, `.build`
- `act(...)` — including `.with`, `.build`

Adding new optional builder methods or new optional fields to existing return types is **not** a breaking change. Removing or renaming a method, changing a required parameter, or narrowing an output type **is**.

### `IAct` interface

The runtime surface returned from `act(...).build()`:

- `do`, `load`, `query`, `query_array`
- `drain`, `settle`, `correlate`
- `reset`, `unblock`, `blocked_streams`, `close`
- `audit`

The signatures, return shapes, and behavioral contracts of these methods are stable. Additive new methods on `IAct` are not breaking. Changing the meaning of an existing call (e.g., what `settle()` guarantees) is.

### Store, Cache, Logger, and Encryptor adapter contracts

The `Store`, `Cache`, `Logger`, and `Encryptor` interfaces in `libs/act/src/types/` define what an adapter must implement. The first three contracts are **executable** — [`@rotorsoft/act-tck`](https://www.npmjs.com/package/@rotorsoft/act-tck) exposes `runStoreTck`, `runCacheTck`, and `runLoggerTck` that exercise every method on each interface against any factory you point them at. If your adapter passes the TCK, it honors the contract; if the contract changes in a way that affects you, the TCK fails first. (The `Encryptor` port is small enough — 3 methods — that operators typically write their own adapter; the built-in `InMemoryEncryptor` doubles as the reference.)

Once 1.0 ships:

- Adding a **required** method to `Store`, `Cache`, `Logger`, or `Encryptor` is a breaking change.
- Adding an **optional** method (with a default fallback in the orchestrator) is not. Optional surface is gated behind a `Capabilities` flag in the TCK so existing adapters keep passing until they opt in.
- Changing the semantics of an existing method (return shape, error contract, ordering guarantees) is breaking.

In-tree adapters are validated against the TCK across multiple backend versions in [`.github/workflows/conformance.yml`](.github/workflows/conformance.yml) — PostgreSQL 14/15/16/17 and `@libsql/client` pinned + latest. A regression in any cell surfaces before it reaches users.

The `encryptor()` port is opt-in by wiring — unlike `store()` / `cache()` / `log()`, there is no built-in default. When unwired, `encryptor()` returns `undefined` and the sensitive-data path (`.sensitive({...})` declarations, `app.forget(...)`) treats sensitive fields as plaintext-and-metadata-only. This "no default" semantic is part of the covered contract — changing it (e.g. installing a default adapter implicitly) would be breaking.

We will be explicit in release notes when this surface changes.

### Lifecycle events

The events emitted by the orchestrator on the public event bus (`ActLifecycleEvents` in `libs/act/src/act.ts`):

- `committed` — events committed by an action in this process (`Snapshot[]`)
- `acked` — reactions that processed successfully (`Lease[]`)
- `blocked` — reactions that exhausted their retry budget (`BlockedLease[]`)
- `settled` — a drain cycle settled (`Drain`)
- `closed` — a close-the-books cycle completed (`CloseResult`)
- `notified` — a different process committed to the same backing store (`StoreNotification`); fires only when `Store.notify` is implemented and at least one reaction is registered

Their names and payload shapes are stable. Adding new optional fields to a payload is not breaking; renaming or removing fields is. Adding new lifecycle event names is not breaking.

### Public type exports

Everything exported from `@rotorsoft/act` and `@rotorsoft/act/types`. If you can `import { Foo } from "@rotorsoft/act"` (or `/types`), the shape of `Foo` is covered.

## Not covered

These may change in **any** release, including patches. Don't depend on them in user code.

- **`internal/`** — anything under `libs/act/src/internal/` or any adapter's internals. These modules are not exported from the package entry points; if you reach into them via deep imports, you are off the contract.
- **Performance characteristics** — throughput, drain latency, cache hit rates. These are best-effort and tracked per-package in `PERFORMANCE.md`. We will not call a regression here a breaking change, but we will document changes in release notes when they meaningfully shift.
- **Adapter implementation details** — connection pooling defaults, SQL/SQLite statement shape, internal queue mechanics, lease bookkeeping. The behavior the adapter is required to deliver is in the `Store`/`Cache` contract; everything else is implementation.
- **Logging formats and trace breadcrumb shapes** — log line text, metadata keys, and trace event shapes are debug aids, not API. Wire-up via `Logger` adapters is covered (see contracts above); the content emitted through them is not.

## How we evolve in each category

- **Builder / `IAct` / public types** — additive changes go in `feat` commits and ship in minor releases. Breaking changes need a major bump and a written migration note in the release.
- **Lifecycle events** — additive (new fields, new events) in minor. Breaking renames or removals in major, with at least one minor release shipping a deprecation alias when feasible.
- **Adapter contracts** — new optional methods land in minor, with the orchestrator providing a default. New required methods or changed semantics land only in major.
- **Events on disk** — schemas are never mutated. Breaking event shape changes use versioned event names (`TicketOpened` → `TicketOpened_v2`); see [Event Schema Evolution](docs/docs/architecture/event-schema-evolution.md). This is a runtime data contract, separate from the API contract above.

## Per-library status

| Package | Tracks core 1.0? |
|---|---|
| `@rotorsoft/act` | Yes — defines the charter |
| `@rotorsoft/act-pg` | Yes — `Store` adapter, same contract |
| `@rotorsoft/act-sqlite` | Yes — `Store` adapter, same contract |
| `@rotorsoft/act-patch` | Yes — stable utility, depended on by `act` reducers |
| `@rotorsoft/act-http` | Yes — umbrella for HTTP integrations (`webhook` helper plus an `sse` subpath that hosts the surface formerly published as `@rotorsoft/act-sse`) |
| `@rotorsoft/act-pino` | Yes — `Logger` adapter, narrow surface |
| `@rotorsoft/act-sse` | **Deprecated** (already past 1.0). Surface moved to `@rotorsoft/act-http/sse`; bug fixes only, scheduled for removal in a future release. Migrate by changing the import path. |
| `@rotorsoft/act-diagram` | Goes to 1.0 alongside core. Diagram output shape (SVG structure, click-through anchors) is *not* part of the stability surface and may evolve. |
| `@rotorsoft/act-tck` | Yes — TCK's published surface (`run*Tck` functions, `Capabilities` types, fixture helpers) joins the 1.x line alongside the `Store`/`Cache`/`Logger` contracts it validates |

Each library's `README.md` carries a one-line stability note linking back to this document.

## Out of scope for the charter

- Documentation under `docs/` and `.claude/skills/` — these evolve continuously and are not versioned with the libraries.
- Example packages under `packages/` — `calculator`, `wolfdesk`, `server`, `client`, `inspector` are reference implementations, not published libraries.
- Tools and scripts under `scripts/`.

## Questions or proposed changes

If you depend on a surface and aren't sure whether it's covered, open an issue. If you think something *should* be covered and isn't, open an issue — this charter is a living contract and we expect to tighten or loosen it as real-world usage exposes the edges.
