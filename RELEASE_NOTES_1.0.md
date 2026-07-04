# Act 1.0 — Release Notes

> **Status:** Shipped. `@rotorsoft/act@1.0.0` was released on 2026-05-21
> (tag `@rotorsoft/act-v1.0.0`), and the packages that track core have moved
> well into their 1.x lines since. This file was staged for ACT-901 (#702) as
> the human-written framing of the 1.0 release and is preserved as the
> historical release narrative; semantic-release manages the per-package
> `CHANGELOG.md` files automatically. The stability charter described below
> is **in effect** — see [STABILITY.md](./STABILITY.md).

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
  `drain`, `settle`, `correlate`, `reset`, `close`, `unblock`,
  `blocked_streams`, `audit`).
- The `Store`, `Cache`, and `Logger` adapter contracts — backed by the
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

## How we got here — the 1.0 milestone

Three phases of work landed in the months leading to 1.0. Each phase is a
coherent slice of the architectural review that surfaced the weak points
1.0 had to address: reaction latency, throughput ceilings, maturity, cross-slice
contracts, singleton ports, and missing primitives for external integration.

### Phase 1 — Foundations

The point of Phase 1 was to make 1.0 a real line in the sand: stable API,
instance-scoped ports for production isolation, and a TCK that lets third
parties write stores with confidence.

- **Stability charter (ACT-301).** [STABILITY.md](./STABILITY.md) explicitly
  delineates what semver protects, what it doesn't, and how each category
  evolves.
- **Scoped ports (ACT-501 / 502 / 503).** Per-Act `store`/`cache` injection
  via `ActOptions.scoped`, threaded through internal modules via
  AsyncLocalStorage. Multi-tenant deployments, parallel test workers, and
  hybrid-storage apps no longer fight the singleton port wiring.
- **TCK (ACT-302).** The `Store`, `Cache`, and `Logger` ports become
  executable contracts via `@rotorsoft/act-tck`. Every in-tree adapter is
  wired through the kit; third-party adapter authors drop a single
  `runStoreTck({ factory })` call into their suite and validate against the
  same surface the framework itself depends on.
- **Conformance matrix (ACT-303).** The TCK runs across PostgreSQL
  14/15/16/17 and `@libsql/client` pinned + latest on every
  adapter-touching PR. Dialect drift between PG majors and libSQL release
  jumps surfaces in CI, not in production.

### Phase 2 — Performance

Phase 2 attacked the two performance questions architects ask first: how
fast does a reaction fire, and how does this scale on Postgres?

- **Cross-process notify (ACT-101).** A new optional `Store.notify(stream)`
  hook lets adapters wake the local drain when a different process commits
  to the same backing store. The `notified` lifecycle event surfaces the
  wakeup to listeners.
- **Per-event priority lanes (ACT-102).** Reactions can be assigned to
  named lanes via `.withLane({ name, leaseMillis, streamLimit, cycleMs })`,
  with each lane getting its own `DrainController`. Hot reactions don't
  share a budget with slow ones.
- **Worker-per-lane dispatch (ACT-1103).** Each declared lane runs its own
  drain controller with its own `leaseMillis`, so a slow webhook reaction
  can't pin a fast notification reaction's lease window. The same code runs
  in three deployment shapes — single process running all lanes,
  process-per-lane, or arbitrary partitioning — because lane filtering is
  just a `WHERE` clause and `SKIP LOCKED` already gives competing-consumer
  semantics.
- **Parallel lease dispatch (ACT-203).** Drain dispatches leases in
  parallel within a cycle rather than sequentially, lifting the
  per-reaction latency floor for fan-out workloads.
- **Latency benchmark scenarios (ACT-103).** Commit-to-reaction latency
  scenarios live in the perf bench, so regressions in the drain hot path
  surface as numbers, not as user reports.

### Phase 3 — Integration & contracts

Phase 3 closed the integration story and tightened the contract guarantees
that grow in importance as Act apps scale to twenty-plus slices.

- **Per-reaction retry backoff (ACT-601).** Configurable per-attempt
  backoff between retries — exponential, constant, or custom — paced
  per-worker on the local `DrainController`.
- **`@rotorsoft/act-http` (ACT-602).** Umbrella package for HTTP-adjacent
  integrations: a `webhook` helper for reaction-driven POST delivery, plus
  an `sse` subpath that hosts the surface formerly published as
  `@rotorsoft/act-sse`. The webhook helper classifies 4xx responses as
  `NonRetryableWebhookError` so they block the stream on first failure
  instead of consuming the full retry budget. With `act-http` landed,
  `@rotorsoft/act-sse` is now deprecated — migration is a one-import
  change from `@rotorsoft/act-sse` to `@rotorsoft/act-http/sse`; the
  legacy package receives bug fixes only and will be removed in a future
  release.
- **External integration patterns + idempotency contract
  doc (ACT-603).** A canonical write-up of inline `webhook` versus
  forwarded bus, idempotency contracts, and recovery patterns.
- **`NonRetryableError` (ACT-604).** Handlers signal permanent failures
  (4xx responses, validation errors, "user deleted" 404s) and the drain
  finalizer blocks the stream on first attempt instead of burning the
  retry budget.
- **Build-time cross-slice event-schema check (ACT-401).** Two same-name
  state partials declaring the same event in `.emits({...})` must
  reference the same Zod schema instance — `act().build()` throws if not.
- **Generated event registry doc (ACT-402).** Build output drives a
  registry doc that lists every event with its producer and consumer slices.
- **Versioned event-name deprecation (ACT-403).** Adding `Foo_v2` to
  `.emits({...})` auto-deprecates `Foo`; static emits targeting the legacy
  version throw at build time, dynamic emits warn once per process.
- **Configurable correlation id generator (ACT-404).** A `correlator`
  delegate on `ActOptions` lets operators inject a project-specific id
  scheme (the default produces a readable id).
- **`Store.query_stats` primitive (#639).** Batched per-stream head with
  opt-in count, tail, and event-name lists — replaces the per-stream
  `query backward, limit:1` pattern across the framework.

### Late additions — observability & operations

Two surfaces landed late in the milestone that don't fit neatly into the
phase narrative but were too foundational to defer.

- **`app.audit()` (ACT-708.5).** An operator-driven multi-category store
  audit on `IAct`, alongside `app.close()`, `app.reset()`, `app.unblock()`,
  and `app.blocked_streams()`. One pass yields findings across nine
  categories — `schema`, `close-candidate`, `restart-candidate`,
  `deprecated-load`, `reaction-health`, `snapshot-drift`, `routing-health`,
  `correlation-gaps`, `clock-anomalies` — each tagged with the
  remediation it suggests. See
  [auditing-a-store](./docs/docs/guides/auditing-a-store.md).
- **Inspector UI for priority/lane + deprecated events (#698, #708).**
  Priority/lane visualization plus a `prioritize()` mutation surface on
  the Inspector, and a deprecated-event-count rollup so operators can spot
  legacy event versions that are still being loaded in production.

All of the above is governed by the charter as of 1.0.

## Versioning across the workspace

| Package | 1.0.0 status | Why |
|---|---|---|
| `@rotorsoft/act` | Yes | Defines the charter |
| `@rotorsoft/act-pg` | Yes | `Store` adapter, same contract |
| `@rotorsoft/act-sqlite` | Yes | `Store` adapter, same contract |
| `@rotorsoft/act-pino` | Yes | `Logger` adapter, narrow surface |
| `@rotorsoft/act-http` | Yes | Umbrella for HTTP integrations — `webhook` helper plus an `sse` subpath that hosts the surface formerly in `@rotorsoft/act-sse` |
| `@rotorsoft/act-diagram` | Yes | Goes to 1.0 alongside core; diagram output shape (SVG structure, click-through anchors) is explicitly *not* part of the stability surface |
| `@rotorsoft/act-patch` | Already past 1.0 | Stable utility, untouched |
| `@rotorsoft/act-sse` | Already past 1.0, **deprecated** | Surface lives on as `@rotorsoft/act-http/sse`. Bug fixes only; will be removed in a future release. Migrate by changing the import path |
| `@rotorsoft/act-tck` | Yes | TCK's published surface (`run*Tck` functions, `Capabilities` types, fixture helpers) joins the 1.x line alongside the `Store`/`Cache`/`Logger` contracts it validates |

## What's not in 1.0

A set of tickets moved to **1.1** so the milestone could close at a
deliberate pace rather than a stretched one. They group into four themes:

**Data-at-rest & long-tail storage.**

- **GDPR crypto-shredding** (#566) — event encryption + per-subject key
  shredding. Defers to 1.1 so it can be designed against the now-stable
  `Store` contract from day one.
- **Postgres partitioning strategy + migration script** (#675, ACT-1101) —
  documented partitioning for stores that outgrow the unpartitioned
  default, with a migration script.
- **Framework-aware event import helper** (#676, ACT-1102) — schema-validated
  bulk import for migrating events from external systems.

**Port mechanism cleanup.**

- **Collapse port-singleton Map + ALS overlay** (#710, ACT-510) — the
  scoped-ports work landed two mechanisms in parallel; 1.1 collapses them
  into one.

**`act-ops` helpers + idempotency (Phase 1.1 tracker, #748, ACT-1110).**

- `withRetry` helper for `ConcurrencyError` (#739, ACT-1111).
- `settleOnCommit` + `logBlocked` bootstrap helpers (#740, ACT-1112).
- `replayUntilSettled` helper for projection rebuilds (#741, ACT-1113).
- Extract `classifyHttpResponse` helper from `webhook` (#742, ACT-1114).
- `extractIdempotencyKey` header parser (#743, ACT-1115).
- Idempotency middleware — core + tRPC/Express/Fastify/Hono adapters (#744, ACT-1116).
- Bootstrap `@rotorsoft/act-ops` workspace package (#745, ACT-1117).
- `IdempotencyStore` port + `InMemoryIdempotencyStore` (#746, ACT-1118).
- `computeMinSafeTtl` dedup window sizing helper (#747, ACT-1119).

None of these block 1.0. They're 1.1 because they're additive 1.x
work — the charter governs them as they land.

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
