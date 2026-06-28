# RFC 1057: Property/fuzz workloads in the differential TCK + cache & logger differential harnesses

- **Status:** accepted <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1057
- **Author:** rotorsoft
- **Created:** 2026-06-28

## Motivation

`runStoreDifferentialTck` (#1030) drives **one** fixed, seeded workload against
two or more `Store` implementations and asserts their normalized outputs match.
A single script only ever exercises one path through the adapter; cross-adapter
drift that depends on a particular interleaving of commits, snapshots, and
truncates can hide between runs. Adapter authors validating a new `Store` want
the differential to probe the *input space*, not one trajectory.

The `Cache` and `Logger` ports had no differential harness at all — a new cache
or logger adapter could only be checked against the contract in isolation
(`runCacheTck` / `runLoggerTck`), never held to behave *identically* to a
reference implementation.

This RFC turns the store differential into a seeded **fuzz campaign** (a family
of randomized workloads) and adds differential harnesses for the other two
ports.

## Public surface added

All additive, all from the `@rotorsoft/act-tck` root entry point.

- **Exports**
  - `runCacheDifferentialTck(options: CacheDifferentialTckOptions): void`
  - `runLoggerDifferentialTck(options: LoggerDifferentialTckOptions): void`
- **Public types**
  - `CacheDifferentialTckOptions` — `{ name; caches: ReadonlyArray<DifferentialCache>; seed?; streams?; runs? }`
  - `DifferentialCache` — `{ name; factory: () => Cache | Promise<Cache> }`
  - `LoggerDifferentialTckOptions` — `{ name; loggers: ReadonlyArray<DifferentialLogger> }`
  - `DifferentialLogger` — `{ name; factory: () => Logger }`
  - New optional field on the existing `StoreDifferentialTckOptions`:
    `runs?: number` (how many randomized workloads to generate; default `8`).
    `seed` is now the *base* seed of the campaign rather than a single
    workload's seed — same field, additive semantics (a single-seed caller
    still gets a deterministic campaign).

Naming follows [CLAUDE.md § Naming conventions](../CLAUDE.md#naming-conventions):
`run<Port>DifferentialTck` mirrors the existing `runStoreDifferentialTck`;
option bags are `Xxx<...>Options`; `runs` is a camelCase public field.

## Alternatives considered

- **Do nothing / keep one fixed script.** Rejected: the issue's whole point is
  to widen coverage past a single trajectory. A fixed script can't catch
  interleaving-dependent drift.
- **fast-check `test.prop` for the store differential.** `@fast-check/vitest`
  is already a dep and `runStorePropertyTck` uses it. Rejected for the
  *differential* because the harness must apply the **same** generated workload
  to every adapter and re-run several read comparisons per workload; a plain
  seeded PRNG over `seed + r` gives byte-stable, replayable workloads and
  deterministic coverage without fast-check's per-run regeneration/shrinking
  machinery (which fits property invariants, not lockstep replay). The
  property harness stays on fast-check; the differential harnesses use the
  same mulberry32 generator the store differential already ships.
- **A logger differential that byte-compares output.** Rejected: logger output
  format is adapter-specific by design (the reason `runLoggerTck` checks shape,
  not bytes). The portable, meaningful differential is robustness + structural
  parity — does the same call surface throw/conform identically across
  implementations — so that's what `runLoggerDifferentialTck` asserts.
- **Drop+seed each store between every workload.** Rejected: each plan
  namespaces its streams with a unique tag, so all workloads coexist in one
  store. A single drop+seed per store keeps durable-adapter cost flat
  regardless of `runs`.

## Stability / charter impact

- Category: **adapter test tooling** — the published surface of
  `@rotorsoft/act-tck`, covered by SemVer alongside the port contracts it
  validates.
- All **additive**: two new exports + their option/spec types, plus one new
  optional field on an existing options bag. No rename, removal, narrowed type,
  or changed semantics. Ships as a **minor** for `@rotorsoft/act-tck`.
- No port method added — uses only existing `Store` / `Cache` / `Logger`
  methods, so there is no new TCK-vs-adapter obligation. The harnesses are
  wired against the in-tree reference adapters (`InMemoryStore` vs `SqliteStore`
  for the store campaign; `InMemoryCache` vs a `Map` reference; `ConsoleLogger`
  vs a no-op reference) for their own coverage.

## Open questions

None.
