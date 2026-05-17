<table width="100%" cellspacing="0">
  <tr>
    <td colspan="2" align="left">
      <a href="https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml"><img src="https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml/badge.svg?branch=master" alt="Build Status"></a>
      <a href="https://github.com/rotorsoft/act-root/actions/workflows/conformance.yml"><img src="https://github.com/rotorsoft/act-root/actions/workflows/conformance.yml/badge.svg?branch=master" alt="Store Conformance"></a>
      <a href="https://coveralls.io/github/Rotorsoft/act-root?branch=master"><img src="https://coveralls.io/repos/github/Rotorsoft/act-root/badge.svg?branch=master" alt="Coverage Status"></a>
      <img src="https://img.shields.io/github/repo-size/rotorsoft/act-root?style=flat-square" alt="Repo Size">
    </td>
  </tr>
  <tr>
    <td width="69%" align="center">
      <a href="https://rotorsoft.github.io/act-root/">
        <img src="./assets/wordmark.png" alt="Act — Fluent Event Sourcing for TypeScript" width="100%">
      </a>
    </td>
    <td width="31%" align="center">
      <a href="https://payhip.com/b/7ezLy">
        <img src="./assets/cover.jpg" alt="Practical Event Sourcing in TypeScript — Book Cover" width="100%">
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://rotorsoft.github.io/act-root/docs/intro"><img src="https://img.shields.io/badge/Get_Started-→-3bb0ff?style=for-the-badge&labelColor=11141b" alt="Get Started"></a>
      <a href="https://rotorsoft.github.io/act-root/"><img src="https://img.shields.io/badge/Documentation-7c5cff?style=for-the-badge&labelColor=11141b" alt="Documentation"></a>
    </td>
    <td align="center">
      <a href="https://payhip.com/b/7ezLy"><img src="https://img.shields.io/badge/Get_the_Book-📖-blue?style=for-the-badge" alt="Get the Book"></a>
    </td>
  </tr>
</table>

## Event sourcing without the ceremony

Most event-sourcing frameworks ask you to learn five concepts before you can ship a feature: aggregates, commands, events, sagas, projections — and the glue between them. Act asks you to learn **three**: actions, state, reactions. The rest is plumbing the framework handles for you.

Your domain stays in TypeScript. Your schemas stay in Zod. Your events live in Postgres (or SQLite, or memory — same API). The framework wires the pipeline: validate input, append to the log, derive state, fan out reactions, drain them under back-pressure, recover blocked streams when something downstream breaks. No Kafka. No RabbitMQ. No saga DSL. No upcasting middleware. No code generators.

If you've tried event sourcing before and bounced off the ceremony, **Act is the version where it clicks**.

## Why teams pick Act

- **Three primitives, not fifteen.** `Actions → {State} ← Reactions` is the whole mental model. The same shape covers commands, queries, projections, sagas, and integrations — without separate vocabularies for each.
- **One schema, two purposes.** Zod schemas define your events at runtime *and* generate the TypeScript types at compile time. No drift, no duplication, no `unknown` escape hatches. Refactor an event, the compiler tells you everywhere it broke.
- **Production-grade out of the box.** Atomic stream claiming via `FOR UPDATE SKIP LOCKED`. Optimistic concurrency on every commit. Automatic retries with configurable backoff. Stream-level dead-lettering with a real recovery API — not a TODO comment that says "wire up your DLQ here."
- **Time-travel is just `load()`.** Reconstruct state at any historical event ID or timestamp with the same call you use for the current state. No separate read store, no "as-of" API to learn.
- **Zero brokers required.** The event store IS the message bus. Postgres with `LISTEN`/`NOTIFY` for low-latency cross-process wakeups; SQLite for embedded; in-memory for tests. Same code, same semantics.
- **100% test coverage, perf-regression-gated.** Every PR runs the full suite at 100% statement/branch/function/line coverage. A separate CI bench fails the build when any scenario's p50 regresses past 1.5× the baseline. Numbers are public ([PERFORMANCE.md](./libs/act/PERFORMANCE.md)) and adapter conformance is enforced via a [Test Compatibility Kit](./libs/act-tck).
- **AI scaffolding that actually works.** Drop a spec — event-modeling diagram, event-storming board, JSON config, or plain prose — into Claude Code with the included [scaffold skill](./.claude/skills/scaffold-act-app/), and get a working monorepo. Domain, API, client, tests.

## 30-second demo

```ts
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.amount }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act().withState(Counter).build();

await app.do("increment", { stream: "c1", actor: { id: "1", name: "u" } }, { by: 5 });

const snap = await app.load(Counter, "c1");
console.log(snap.state); // { count: 5 }
```

That's the whole loop: define state, declare actions, dispatch, load. Everything else — projections, reactions, slices, cross-process drain, time-travel — is more of the same builder calls.

## The three primitives

- **State** — the data you care about. Defined as a Zod schema, evolved by emit-and-patch.
- **Actions** — the changes you want to make to it. Validated by Zod, emitted as immutable events, committed under optimistic concurrency.
- **Reactions** — what happens as a result. Fired in commit order, retried under back-pressure, blocked-streams visible to operators.

```
   ┌──────────┐    Actions     ┌──────────┐    Reactions     ┌──────────────┐
   │  Client  │ ─────────────► │  Act     │ ───────────────► │  Downstream  │
   └──────────┘                │  State   │                  │  (webhooks,  │
                  load()       │  Events  │   correlate +     │  projections,│
              ◄─────────────── │  Drain   │      drain         │  bus, etc.)  │
                               └──────────┘                  └──────────────┘
```

That's the whole architecture. Slices group related state + reactions into vertical features; projections build read models from the same event stream — all using the same builder vocabulary.

## What's in the box

| | |
|---|---|
| 🏗️ **Framework core** | State, actions, reactions, slices, projections, snapshots, cache, correlation, drain, recovery — all in one focused 0-dep package (`@rotorsoft/act`). |
| 💾 **Production stores** | PostgreSQL (`@rotorsoft/act-pg`) with cross-process `LISTEN`/`NOTIFY`. SQLite (`@rotorsoft/act-sqlite`) for single-node and edge. InMemory bundled in core for tests. All three pass the same conformance suite. |
| 🌐 **HTTP integrations** | Inline `webhook` delivery with auto-derived `Idempotency-Key`, status-classified retries, and a published receiver-side contract. SSE for live state broadcast (`@rotorsoft/act-http`). |
| 🔍 **Live inspector** | A web app (`packages/inspector`) that connects to any Act store. Browse the event log, watch correlation + drain in real time, inspect blocked streams, page through subscription positions. |
| 🎨 **Interactive diagrams** | `@rotorsoft/act-diagram` reads your TypeScript and renders an SVG model of states, actions, events, slices, projections, and reactions — with click-through to source. |
| 🪵 **Pluggable logging** | `@rotorsoft/act-pino` adapter for transports, redaction, async sinks. The framework's default `ConsoleLogger` covers dev. |
| ⏪ **Time-travel** | `app.load(State, id, _, { before: 5000 })`. Same `load()` as everything else. |
| 🛟 **Recovery loop** | `app.blocked_streams()` finds what's wedged. `app.unblock(...)` resumes without replaying history. `app.reset(...)` rebuilds projections from scratch. |
| 🤖 **AI scaffolding** | Drop a functional spec into [Claude Code](https://claude.ai/code) with the bundled skill. Get a working monorepo: domain, tRPC API, React client, tests. |

## Packages

### Core

| Package | Description |
|---|---|
| [@rotorsoft/act](https://github.com/rotorsoft/act-root/tree/master/libs/act)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act) | The framework. State, actions, reactions, slices, projections — Zod-typed end to end. |
| [@rotorsoft/act&#x2011;pg](https://github.com/rotorsoft/act-root/tree/master/libs/act-pg)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act-pg.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-pg)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act-pg.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-pg) | PostgreSQL store. Production-ready, atomic stream claiming, snapshots, connection pooling, cross-process `LISTEN`/`NOTIFY`. |
| [@rotorsoft/act&#x2011;sqlite](https://github.com/rotorsoft/act-root/tree/master/libs/act-sqlite)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act-sqlite.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-sqlite)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act-sqlite.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-sqlite) | libSQL store for embedded or single-node deployments. |
| [@rotorsoft/act&#x2011;patch](https://github.com/rotorsoft/act-root/tree/master/libs/act-patch)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act-patch.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-patch)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act-patch.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-patch) | Immutable deep-merge patch utility — drives `act` state reducers. Zero deps, browser-safe. |

### Integrations

| Package | Description |
|---|---|
| [@rotorsoft/act&#x2011;http](https://github.com/rotorsoft/act-root/tree/master/libs/act-http)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act-http.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-http)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act-http.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-http) | HTTP integrations — `webhook` for inline POST delivery, SSE for live state broadcast (subpath exports). |
| [@rotorsoft/act&#x2011;pino](https://github.com/rotorsoft/act-root/tree/master/libs/act-pino)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act-pino.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-pino)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act-pino.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-pino) | Pino logger adapter — transports, redaction, async sinks. |
| [@rotorsoft/act&#x2011;diagram](https://github.com/rotorsoft/act-root/tree/master/libs/act-diagram)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act-diagram.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-diagram)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act-diagram.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-diagram) | Interactive SVG diagram extractor — your domain model, rendered live, with click-through to source. |
| [@rotorsoft/act&#x2011;tck](https://github.com/rotorsoft/act-root/tree/master/libs/act-tck)<br>[![npm](https://img.shields.io/npm/v/@rotorsoft/act-tck.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-tck)&nbsp;[![downloads](https://img.shields.io/npm/dm/@rotorsoft/act-tck.svg?style=flat-square&label=)](https://www.npmjs.com/package/@rotorsoft/act-tck) | Test Compatibility Kit for Store/Cache/Logger ports — drop-in vitest suite that validates any custom adapter against the contract. |

### Tools

Workspace apps (not published to npm):

| Package | Description |
|---|---|
| [@rotorsoft/act&#x2011;inspector](https://github.com/rotorsoft/act-root/tree/master/packages/inspector)<br>_web app_ | Event sourcing observatory — connect to any Act PostgreSQL store and inspect events in real time. Event log, SVG timeline, stream inspector, correlation explorer, drain monitor with live polling. |

## Production-ready

Numbers, not promises:

- **100% test coverage** — statements, branches, functions, lines. Every PR. No exceptions for "defensive" branches. [Coverage badge](https://coveralls.io/github/Rotorsoft/act-root?branch=master).
- **Property-based tests** with `fast-check` cover commit version monotonicity, claim/lease lifecycle, cache/store coherence, correlate→drain delivery exactness, and close idempotency. See [`libs/act/test/property/`](./libs/act/test/property/).
- **CI perf regression guard** runs the bench suite on every PR and fails when any scenario's p50 exceeds 1.5× the checked-in baseline. Numbers and scenarios in [PERFORMANCE.md](./libs/act/PERFORMANCE.md#ci-regression-guard).
- **Store conformance matrix** — all three in-tree stores (PG, SQLite, InMemory) pass the same TCK, currently 60+ test cases each. Custom adapters get the same harness. [Conformance badge](https://github.com/rotorsoft/act-root/actions/workflows/conformance.yml).
- **Stability charter** — [STABILITY.md](./STABILITY.md) names exactly which surfaces are covered by semver. Breaking changes require a `BREAKING CHANGE:` footer and a written migration note.

## AI-assisted application scaffolding

Build a complete Act application from a functional spec using [Claude Code](https://claude.ai/code) and the bundled skill.

```sh
# Project skill (recommended)
mkdir -p .claude/skills
cp -r /path/to/act-root/.claude/skills/scaffold-act-app .claude/skills/

# Or install personally across all projects
cp -r /path/to/act-root/.claude/skills/scaffold-act-app ~/.claude/skills/
```

Then open Claude Code in an empty directory and say: **"Build me an app from this spec: `<link-or-file>`"**

Any spec format works — event modeling diagrams, event storming boards, JSON configs, user stories, or plain prose. The skill maps the vocabulary to framework concepts (aggregates → states, commands → actions, policies → reactions, read models → projections), scaffolds the monorepo (domain, tRPC API, React client, vitest), and walks the 10-step build process: schemas, invariants, states, slices, projections, bootstrap, router, client, tests, dependencies. Production guidance for PostgreSQL, background processing, automated jobs, and error handling is baked in.

Review, iterate, deploy.

## Documentation & resources

- **[Get started](https://rotorsoft.github.io/act-root/docs/intro)** — 5-minute walkthrough from `pnpm add` to a working app
- **[Concepts & guides](https://rotorsoft.github.io/act-root/docs/intro)** — domain modeling, state management, error handling, real-time, external integration, production checklist
- **[API reference](https://rotorsoft.github.io/act-root/docs/api/)** — typedoc-generated, refreshed on every push to `master`
- **[Architecture](https://rotorsoft.github.io/act-root/docs/architecture)** — concurrency, cache/snapshots, correlation+drain, close-cycle, schema evolution, extension points
- **[Performance & benchmarks](./libs/act/PERFORMANCE.md)** — throughput numbers per store, CI regression guard, optimization history
- **[Philosophy](./docs/PHILOSOPHY.md)** — DDD / Event Sourcing / CQRS lineage, integration patterns, why this shape
- **[The book](https://payhip.com/b/7ezLy)** — _Practical Event Sourcing in TypeScript_ — Event Sourcing / CQRS / DDD applied end-to-end through a multiplayer Risk game
- **[Examples](#examples)** below — calculator, WolfDesk ticketing, tRPC integration

## Examples

- **[Calculator](./packages/calculator/src/)** — actions are key presses, a digit board tracks how many times each digit has been pressed. The hello-world for the framework.
- **[WolfDesk](./packages/wolfdesk/src/)** — reference implementation of the WolfDesk ticketing system from Vlad Khononov's [_Learning Domain-Driven Design_](https://a.co/d/1udDtcE). Multi-slice domain, real workflows, blocked-stream recovery, webhook integration.
- **[tRPC client + server](./packages/server/src/)** — exposes the calculator as a web app. The shape that lets the AI-scaffolding skill produce its tRPC layer.

## Contributing

Fork, branch, install (`pnpm install`), test (`pnpm test`), lint (`pnpm lint`), commit, push, PR. Conventional Commits. 100% coverage gate. The full pre-handoff workflow lives in [CLAUDE.md](./CLAUDE.md); the per-package contributing guide is in [docs/docs/guides/contributing-new-package.md](./docs/docs/guides/contributing-new-package.md). Open an issue or join [GitHub Discussions](https://github.com/rotorsoft/act-root/discussions) for questions.

## Versioning

[SemVer](https://semver.org/). What semver protects and what it doesn't is documented in [STABILITY.md](./STABILITY.md); release notes and breaking changes are in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
