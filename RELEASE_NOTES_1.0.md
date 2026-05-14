# Act 1.0 — Release Notes (Draft)

> **Status:** Draft. This file stages the 1.0.0 release narrative for ACT-304
> (#702) to consume when the release mechanics fire. semantic-release manages
> the per-package `CHANGELOG.md` files automatically; this document is the
> human-written framing that lands as the GitHub Release body when 1.0.0 is
> cut. Once the release ships, this file is archived under `docs/`.

---

## What 1.0 means

Act has been used in production with a public API that hasn't regressed in
months. Every breaking change has been a deliberate version-bump preface,
not an accident. 1.0 is the formalization of what's already true: a written
stability charter, an executable contract for the extension points, and a
version label that matches the actual maturity of the surface.

It is not a feature release. Nothing semantically changes between the last
0.x and 1.0.0. What changes is the **commitment**.

## The stability charter

See [STABILITY.md](./STABILITY.md) for the full text. The short version:

**Covered by semver — breaking changes require a major bump:**

- The builder API (`state`, `slice`, `projection`, `act` and their fluent
  surfaces).
- The `IAct` runtime interface (`do`, `load`, `query`, `query_array`,
  `drain`, `settle`, `correlate`, `reset`, `close`).
- The `Store` and `Cache` adapter contracts — backed by the
  [`@rotorsoft/act-tck`](./libs/act-tck) test compatibility kit, so the
  contract is executable and verifiable.
- Lifecycle event names and payload shapes
  (`committed`, `acked`, `blocked`, `settled`, `closed`, `notified`).
- Public type exports from `@rotorsoft/act` and `@rotorsoft/act/types`.

**Not covered — may change in any release:**

- Anything under `internal/`.
- Performance characteristics (best-effort, tracked per-package in
  `PERFORMANCE.md`).
- Adapter implementation details outside the contract.
- Log formats and trace breadcrumb shapes.

## How we got here — the 1.0 milestone in one paragraph

Three rounds of foundation work landed in the months leading to 1.0:

- **Scoped ports (ACT-501/502/503).** Per-Act `store`/`cache` injection via
  `ActOptions.scoped`, threaded through internal modules via
  AsyncLocalStorage. Multi-tenant deployments, parallel test workers, and
  hybrid-storage apps no longer fight the singleton port wiring.
- **TCK (ACT-302).** The Store, Cache, and Logger ports become executable
  contracts via `@rotorsoft/act-tck`. Every in-tree adapter is wired
  through the kit; third-party adapter authors drop a single
  `runStoreTck({ factory })` call into their suite and validate against
  the same surface the framework itself depends on.
- **Conformance matrix (ACT-303).** The TCK runs across PostgreSQL 14/15/16/17
  and `@libsql/client` pinned + latest on every adapter-touching PR.
  Dialect drift between PG majors and libSQL release jumps are caught
  in CI, not in production.

Alongside the foundations, Phase 2 performance work (ACT-101 cross-process
notify, ACT-102 priority lanes, ACT-103 latency benchmarks, ACT-203
parallel lease dispatch) and Phase 3 contracts work (ACT-401 cross-slice
event-schema agreement, ACT-403 versioned event-name deprecation) shipped
over the same window. All of it is governed by the charter as of 1.0.

## Versioning across the workspace

| Package | 1.0.0 status | Why |
|---|---|---|
| `@rotorsoft/act` | Yes | Defines the charter |
| `@rotorsoft/act-pg` | Yes | `Store` adapter, same contract |
| `@rotorsoft/act-sqlite` | Yes | `Store` adapter, same contract |
| `@rotorsoft/act-pino` | Yes | `Logger` adapter, narrow surface |
| `@rotorsoft/act-sse` | Yes | Public broadcast surface, governed by charter |
| `@rotorsoft/act-diagram` | Yes | Goes to 1.0 alongside core; diagram output shape (SVG structure, click-through anchors) is explicitly *not* part of the stability surface |
| `@rotorsoft/act-patch` | Already past 1.0 | Stable utility, untouched |
| `@rotorsoft/act-tck` | Stays at 0.x | TCK API itself (run* functions, capabilities flags, fixture helpers) is still stabilizing against third-party authors. The Store/Cache/Logger contracts it validates are covered by the charter; the kit's own surface is not yet |

## What's not in 1.0

A few items moved to **1.1** so the milestone could close at a deliberate
pace rather than a stretched one:

- **GDPR crypto-shredding** (#566) — event encryption + per-subject key
  shredding. Defers to 1.1 so it can be designed against the now-stable
  Store contract from day one.

A few items live in 1.0 as "ship-when-ready, not blocking":

- **Outbox builder + webhook adapter** (ACT-601 / 602 / 603) — at-least-once
  external delivery on top of the event log.
- **Generated event registry doc** (ACT-402) — build-output-driven docs.
- **`Store.query_heads`** (#639) — batched per-stream latest-event lookup
  primitive.
- **Inspector UI updates** (#698 priority-lane viz, #708 deprecated event
  counts) — observability surface.

All of these can land in 1.x point releases without breaking the charter.

## Upgrading from 0.x

There are no required code changes. If you were on 0.39.x or later and your
imports come from `@rotorsoft/act` (not deep paths into `internal/`), the
upgrade to 1.0.0 is a version bump and nothing else.

If you wrote a custom `Store`, `Cache`, or `Logger` adapter, validate it
against [`@rotorsoft/act-tck`](./libs/act-tck). If it passes the TCK
today, it will keep passing across the 1.x line.

## Thanks

To everyone who filed an issue, sent a PR, or stress-tested an adapter
against a production load the test suite didn't cover. 1.0 is yours.
