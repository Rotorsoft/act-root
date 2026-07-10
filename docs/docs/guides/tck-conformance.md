---
id: tck-conformance
title: TCK conformance & the compatibility badge
---

# TCK conformance & the compatibility badge

The three port contracts — `Store`, `Cache`, `Logger` — are the seams where Act meets infrastructure. The in-tree adapters (`InMemoryStore`, `@rotorsoft/act-pg`, `@rotorsoft/act-sqlite`, `@rotorsoft/act-pino`) are not the only ones allowed to fill those seams. A Redis cache, a MongoDB store, a MySQL store, a logger that ships to your own collector — none of those need to live in this repository to be first-class. They need to honor the contract.

`@rotorsoft/act-tck` is how you prove they do. It turns each port from "an interface plus tribal knowledge" into an executable contract: drop a `run*Tck` call into your test suite, point it at your factory, and the kit exercises every method, every documented behavior, every error mode the framework relies on. If your adapter passes, it is interchangeable with the ones Act ships.

This guide is the advertised path for a **third-party adapter living in its own repository**. It assumes you are starting from an empty directory and publishing to npm under your own scope — not adding a package to this monorepo. (If you _are_ contributing an adapter back to the repo, follow [contributing-new-package.md](contributing-new-package.md) instead; the per-port deep dives in [writing-a-store](writing-a-store.md), [writing-a-cache](writing-a-cache.md), and [writing-a-logger](writing-a-logger.md) cover the contract method by method.)

## The shape of a conformant adapter repo

A standalone adapter is a small package. Strip away the dialect-specific glue and the skeleton is the same whichever port you implement:

```
my-act-redis-cache/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   └── index.ts            # export { RedisCache }  — implements Cache
└── test/
    ├── cache-tck.spec.ts   # runCacheTck({ factory: () => new RedisCache(…) })
    └── stability.spec.ts   # runStabilityTck — guards your own public surface
```

The dependency wiring is what differs from an in-tree adapter. You depend on `@rotorsoft/act` as a **peer** (the host app brings its own copy, and you must not bundle a second one), and on `@rotorsoft/act-tck` as a **dev** dependency (it only runs in your test suite — it never ships to consumers):

```jsonc
{
  "name": "my-act-redis-cache",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "peerDependencies": {
    "@rotorsoft/act": ">=1.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@rotorsoft/act": "latest",
    "@rotorsoft/act-tck": "latest",
    "vitest": "latest"
    // + your backend client (ioredis, mongodb, mysql2, …)
  }
}
```

Two things to note versus the in-monorepo guides:

- **`latest` from the registry, not `workspace:^`.** The `workspace:` protocol only resolves inside this monorepo. A standalone repo pulls published versions. List `@rotorsoft/act` in `devDependencies` too so your own tests have something to type-check and run against — the `peerDependencies` entry is the contract you advertise to consumers, the `devDependencies` entry is the copy your CI installs.
- **The TCK re-exports the port types.** You can write `import type { Cache } from "@rotorsoft/act-tck"` instead of reaching into `@rotorsoft/act/types`. Same types — it keeps your test imports on one line and stops the two paths from drifting.

## Running the TCK

Each port has one entry point. Pass it a display `name`, a `factory` that returns a fresh adapter per test, and (for the store) a `capabilities` bag declaring the optional methods you implement.

```ts no-check
// test/cache-tck.spec.ts
import { runCacheTck } from "@rotorsoft/act-tck";
import { RedisCache } from "../src/index.js";

runCacheTck({
  name: "RedisCache",
  factory: () => new RedisCache({ url: process.env.REDIS_URL! }),
});
```

```ts no-check
// test/store-tck.spec.ts
import { runStoreTck } from "@rotorsoft/act-tck";
import { MysqlStore } from "../src/index.js";

runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ host: "localhost", database: "act_tck" }),
  capabilities: {
    notify: false,        // flip on once you implement Store.notify
    restore: false,       // ... Store.restore
    pii_isolation: false, // ... Store.forget_pii
    source_matches: false // ... reverse-regex narrowing in query_streams
  },
});
```

```ts no-check
// test/logger-tck.spec.ts
import { runLoggerTck } from "@rotorsoft/act-tck";
import { MyLogger } from "../src/index.js";

runLoggerTck({ name: "MyLogger", factory: () => new MyLogger({ level: "trace" }) });
```

The store kit is the largest — it runs 29+ contract cases by default and unlocks more as you flip capability flags. The capability gates exist so an adapter that can't (or doesn't yet) implement an optional method keeps passing: leave the flag `false` (or omit it) and those cases stay parked. Flip it to `true` only once the method is real, and the kit holds you to the full contract for it. The per-port guides spell out what each flag unlocks and what the optional methods must guarantee.

Run them the way you run any vitest suite:

```bash
npx vitest run
```

Green means your adapter honors every behavior the orchestrator depends on. Dialect-specific tests — connection-pool exhaustion, transaction edge cases, your backend's own error mapping — stay in their own spec files alongside the TCK spec. The kit only asserts what _every_ adapter of that port must do; it deliberately knows nothing about your backend.

## Guarding your own public surface

The TCK proves you honor _Act's_ contract. A second, smaller kit — `runStabilityTck` — guards _your own_ surface from accidental drift. It snapshots the source text of every entry point you declare (plus everything it re-exports through relative imports) and fails when a rename, a removed export, or a changed signature shows up unannounced. It is the same gate every in-tree package uses on itself.

```ts
// test/stability.spec.ts
import path from "node:path";
import { runStabilityTck } from "@rotorsoft/act-tck";

runStabilityTck({
  name: "my-act-redis-cache",
  entryPoints: { "": path.resolve("src/index.ts") },
});
```

The first run writes a snapshot; commit it. From then on, any change to your public exports surfaces as a snapshot diff in the PR — you either accept it deliberately (`vitest -u`) or push back. It reads `.ts` source directly, so no build step is required before it runs.

## The conformance badge

Once the TCK is green in your CI, advertise it. The badge is a static [shields.io](https://shields.io) markdown snippet — drop it at the top of your adapter's README, linked back to this guide so readers know exactly what "conformant" means:

```md
[![Act TCK](https://img.shields.io/badge/Act%20TCK-conformant-3bb0ff)](https://rotorsoft.github.io/act-root/docs/guides/tck-conformance)
```

[![Act TCK](https://img.shields.io/badge/Act%20TCK-conformant-3bb0ff)](https://rotorsoft.github.io/act-root/docs/guides/tck-conformance)

Name which port you implement and which capabilities you've turned on, so a consumer can tell a `notify`-capable store from a single-node one at a glance:

```md
[![Act Store TCK](https://img.shields.io/badge/Act%20Store%20TCK-conformant-3bb0ff)](https://rotorsoft.github.io/act-root/docs/guides/tck-conformance)
[![Act Cache TCK](https://img.shields.io/badge/Act%20Cache%20TCK-conformant-3bb0ff)](https://rotorsoft.github.io/act-root/docs/guides/tck-conformance)
[![Act Logger TCK](https://img.shields.io/badge/Act%20Logger%20TCK-conformant-3bb0ff)](https://rotorsoft.github.io/act-root/docs/guides/tck-conformance)
```

### The convention

The badge is a claim, and the claim is only honest if it's mechanically true. The convention is simple:

- **Display it only when the TCK passes in CI** — not on a local green run, not aspirationally. A conformance badge on a repo whose CI is red (or has no TCK job) is the worst of both worlds: it manufactures trust the code hasn't earned.
- **Pin the kit version you tested against.** The contract evolves: when a port gains a method, the TCK gains cases for it (gated behind a capability flag so you keep passing until you opt in). Re-run against the newer kit before bumping the version your badge implies.
- **Wire it to your CI run, not just this guide.** Prefer a badge that turns red when your build does — most CI providers expose a status badge for a workflow. Point the link at your CI run and readers get a live signal instead of a static assertion. The static shields.io badge above is the fallback for repos that want the label without the plumbing.

### A CI job that earns the badge

The kit is just vitest, so the CI job is whatever runs your tests against a real backend. This monorepo's own `Store Conformance Matrix` workflow (`.github/workflows/conformance.yml`) is a worked example: it stands up Postgres and libSQL services across several engine versions and runs the store TCK against each, catching dialect regressions a single-version run can't see. A third-party store adapter can copy the shape directly — swap the service container for your backend, swap the `pnpm -F …` invocation for `npx vitest run`, and matrix over the engine versions you promise to support. That matrix _is_ the evidence behind the badge.

## Worked, passing examples

You do not have to take "a conformant adapter is possible" on faith — the adapters Act ships are the proof, and their TCK specs are short enough to read in a sitting:

- `InMemoryStore` — the reference store implementation; its TCK spec runs the full store contract with `restore`, `pii_isolation`, `concurrent_claim`, and `source_matches` on (`notify` stays off — the in-memory store is single-process by design and does not implement it).
- `@rotorsoft/act-pg` / `@rotorsoft/act-sqlite` — production stores; same TCK spec, different `capabilities` bags, run against real engines in the conformance matrix.
- `InMemoryCache` — the reference cache; its `runCacheTck` spec is the template the Redis sketch above mirrors.
- `ConsoleLogger` / `@rotorsoft/act-pino` — the two shipped loggers, both validated by `runLoggerTck`.

Clone one, read its `test/*-tck.spec.ts`, and you have the exact shape your own spec takes. The only difference in your repo is the dependency protocol (`latest`, not `workspace:^`) covered above.

## Cross-references

- Per-port deep dives: [writing-a-store](writing-a-store.md), [writing-a-cache](writing-a-cache.md), [writing-a-logger](writing-a-logger.md)
- The contracts themselves: [extension-points](../architecture/extension-points.md) and [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts)
- TCK source: [`libs/act-tck/src`](https://github.com/Rotorsoft/act-root/tree/master/libs/act-tck/src)
- Contributing an adapter back to the monorepo instead: [contributing-new-package](contributing-new-package.md)
