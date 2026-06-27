# Stability Charter

Act has been used in production with a public API that hasn't regressed in months. Every breaking change has been a deliberate version-bump preface, not an accident. This document is the explicit contract: what semver protects, what it doesn't, and how we evolve in each category.

> **Status:** This charter takes effect with the **1.0** release, which is gated on completion of [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1). The current 0.x line already follows it in spirit — treat anything listed under "Covered" as stable in practice today, and anything under "Not covered" as subject to change.

## Covered by semver

Breaking changes to anything in this list require a **major** version bump and an entry in the relevant `CHANGELOG.md`.

### Builder API

The fluent surfaces exported from `@rotorsoft/act`:

- `state(...)` — including `.init`, `.emits`, `.patch`, `.on` (with optional `ActionOptions` second argument for per-action retry policy), `.given`, `.emit`, `.snap`, `.discloses` (sensitive-data epic #566 — disclosure predicate for `sensitive(...)`-marked event fields), `.autocloses` (online close-the-books epic #802 — predicate the autoclose cycle calls per candidate stream), `.archives` (online close-the-books epic #802 — companion archiver run while the stream is guarded, before truncate), `.build`
- `slice(...)` — including `.actions`, `.given`, `.build`
- `projection(...)` — including `.from`, `.on`, `.build`
- `act(...)` — including `.with`, `.build`
- `sensitive(zodType)` (sensitive-data epic #566 — schema-level marker for PII fields; the orchestrator splits sensitive keys off `data` into `pii` on commit and gates reads by `.discloses`)

Adding new optional builder methods or new optional fields to existing return types is **not** a breaking change. Removing or renaming a method, changing a required parameter, or narrowing an output type **is**.

### `IAct` interface

The runtime surface returned from `act(...).build()`:

- `do`, `load`, `query`, `query_array`
- `drain`, `settle`, `correlate`
- `reset`, `unblock`, `blocked_streams`, `close`
- `forget` (sensitive-data epic #566 — wipe a stream's PII via `Store.forget_pii`, invalidate the cache, emit the `forgotten` lifecycle event; throws on adapters without `pii_isolation`)
- `audit`

The signatures, return shapes, and behavioral contracts of these methods are stable. Additive new methods on `IAct` are not breaking. Changing the meaning of an existing call (e.g., what `settle()` guarantees) is.

### Store, Cache, and Logger adapter contracts

The `Store`, `Cache`, and `Logger` interfaces in `libs/act/src/types/` define what an adapter must implement. The contracts are **executable** — [`@rotorsoft/act-tck`](https://www.npmjs.com/package/@rotorsoft/act-tck) exposes `runStoreTck`, `runCacheTck`, and `runLoggerTck` that exercise every method on each interface against any factory you point them at. If your adapter passes the TCK, it honors the contract; if the contract changes in a way that affects you, the TCK fails first.

Once 1.0 ships:

- Adding a **required** method to `Store`, `Cache`, or `Logger` is a breaking change.
- Adding an **optional** method (with a default fallback in the orchestrator) is not. Optional surface is gated behind a `Capabilities` flag in the TCK so existing adapters keep passing until they opt in. Current capability-gated additions: `notify`, `restore`, `pii_isolation` (sensitive-data epic #566 — adapters supporting the `pii` field on commit/load plus `forget_pii(stream)`).
- Changing the semantics of an existing method (return shape, error contract, ordering guarantees) is breaking.

In-tree adapters are validated against the TCK across multiple backend versions in [`.github/workflows/conformance.yml`](.github/workflows/conformance.yml) — PostgreSQL 14/15/16/17 and `@libsql/client` pinned + latest. A regression in any cell surfaces before it reaches users.

We will be explicit in release notes when this surface changes.

### Lifecycle events

The events emitted by the orchestrator on the public event bus (`ActLifecycleEvents` in `libs/act/src/act.ts`):

- `committed` — events committed by an action in this process (`Snapshot[]`)
- `acked` — reactions that processed successfully (`Lease[]`)
- `blocked` — reactions that exhausted their retry budget (`BlockedLease[]`)
- `settled` — a drain cycle settled (`Drain`)
- `closed` — a close-the-books cycle completed (`CloseResult`)
- `notified` — a different process committed to the same backing store (`StoreNotification`); fires only when `Store.notify` is implemented and at least one reaction is registered
- `forgotten` — a stream's sensitive-data payload was wiped via `app.forget(stream)` (`{stream, at, eventCount}`); fires once per successful call, never on idempotent re-forget

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

## Support window

The charter above says *what* a major bump protects. This section says *how long* a given major is supported, so adopters can plan upgrades against a published window rather than guesswork.

Act is maintained by a small team. The windows below are deliberately modest — we would rather state a window we can keep than advertise an LTS we can't staff.

- **Active line — the latest published major.** Receives new features, bug fixes, and security patches. This is where development happens. Always upgrade within the active major to get fixes; there are no long-lived patch branches inside a major beyond the latest minor.
- **Previous major — maintenance.** When a new major `N` ships, the prior major `N-1` enters a maintenance window of **at least 6 months** during which it receives **security fixes and critical correctness fixes only** (data loss, lost events, crashes). No new features, no non-critical fixes. After the window closes, `N-1` is end-of-life.
- **Older majors (`N-2` and earlier) — unsupported.** Best-effort community help via [issues](https://github.com/rotorsoft/act-root/issues) and [discussions](https://github.com/rotorsoft/act-root/discussions), no guaranteed fixes or releases.

During the current **0.x** line (pre-1.0), only the **latest published version** is supported. There are no maintenance branches before 1.0 — upgrade to the newest release to pick up fixes. The windows above take effect with the [1.0 release](https://github.com/Rotorsoft/act-root/milestone/1).

The same window applies to every package that tracks core (see the table below): an `act-pg` or `act-sqlite` release is supported for as long as the core major it targets is.

## Deprecation policy

We remove public surface slowly and with warning. The general rule: **a deprecation is announced in a minor release and the surface is removed no earlier than the next major** — so anything you depend on survives at least until a major boundary you opt into, and you get advance notice before then.

- **API surface** (builder methods, `IAct` methods, public types, lifecycle events). A deprecated entry point stays functional, is marked deprecated in its doc-comment and in the release notes for the minor that deprecates it, and is removed only in a subsequent major with a migration note in the changelog. Renames ship the old name as a deprecated alias for at least one minor where feasible (see [How we evolve in each category](#how-we-evolve-in-each-category)).
- **Events on disk** are never deprecated out from under you — they are append-only history. Breaking an event's shape means adding a new versioned name (`Foo` → `Foo_v2`); the old reducer keeps replaying historical `Foo` events indefinitely. Adding `Foo_v2` to `.emits({...})` auto-deprecates `Foo` for *emission* only: new writes use the current version, replay of old events is untouched. See [Event Schema Evolution](docs/docs/architecture/event-schema-evolution.md).
- **Deprecation is observable at startup.** The `_v<n>` versioned-event-name convention is load-bearing: `act().build()` emits a one-line advisory enumerating every deprecated event version in scope, and `app.registry.deprecated_events(state_name)` exposes the set programmatically for callers that want to enforce their own policy. Static `.emit("Foo")` targeting a deprecated version throws at build time, so the most common mistake fails fast.
- **Deprecated packages** carry their own removal note. `@rotorsoft/act-sse` is the current example — its surface moved to `@rotorsoft/act-http/sse`, it receives bug fixes only, and it is scheduled for removal in a future major. Migrate by changing the import path.

## Security fixes

- **Reporting.** Report suspected vulnerabilities privately via a [GitHub security advisory](https://github.com/Rotorsoft/act-root/security/advisories/new) rather than a public issue. We aim to acknowledge a report within a few business days and to coordinate disclosure with the reporter once a fix is available.
- **What gets patched.** Security fixes land on the **active major** and on any **previous major still inside its 6-month maintenance window** (see [Support window](#support-window)). Majors past end-of-life do not receive backports; the remedy there is upgrading. During 0.x, fixes land on the latest release only.
- **Scope.** Vulnerabilities in `@rotorsoft/act` and the packages that track it are in scope. Issues in example apps under `packages/` (`calculator`, `wolfdesk`, `server`, `client`, `inspector`) are reference code, not published libraries — report them as ordinary issues. Dependency advisories are tracked via automated updates and patched in the active line.

## Migration guides

Every breaking (major) release ships a migration guide in the **same PR** that lands the breaking change, so the upgrade path is documented before the version is cut. The conventions, page template, and release-PR checklist live in [MIGRATING.md](MIGRATING.md).

The documentation site is [versioned](https://docusaurus.io/docs/versioning): the live `docs/` folder is the **Current** set and tracks the latest API, while each released line is snapshotted under `docs/versioned_docs/` and selectable from the navbar version dropdown. Older-major users get a pinned reference; the migration guide for a release sits next to the API docs it describes.

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

## Adding new covered surface

This charter protects what already exists; it doesn't gate what gets added. New public surface — a new export, builder method, port method, or lifecycle event — calcifies under semver the moment it ships. Before it does, write a one-page RFC: copy [`rfcs/0000-template.md`](rfcs/0000-template.md) to `rfcs/NNNN-<slug>.md` and capture the motivation, the exact surface added, the alternatives considered, and the charter impact. See [`rfcs/README.md`](rfcs/README.md) for what does and doesn't require one. The PR that adds the surface links the RFC.

## Questions or proposed changes

If you depend on a surface and aren't sure whether it's covered, open an issue. If you think something *should* be covered and isn't, open an issue — this charter is a living contract and we expect to tighten or loosen it as real-world usage exposes the edges.
