# RFC 0002: create-act-app scaffolder

- **Status:** draft <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1037
- **Author:** rotorsoft
- **Created:** 2026-06-27

## Motivation

There is no one-command way to start an Act project. A newcomer who has read the
intro and wants a running app has to clone the monorepo, find the right example
under `packages/`, copy it out, strip the workspace wiring, repoint
dependencies from `workspace:*` to published versions, and delete the parts they
don't need. Every one of those steps is a chance to give up. The frameworks Act
competes with for attention all ship a scaffolder — `npm create vite`,
`create-next-app`, `npm init @eslint/config` — because the gap between "this
looks interesting" and "I have it running" is where most evaluations are lost.

We already have the raw material: the `calculator` example is a complete, tested,
runnable Act app. What's missing is a way to stamp a trimmed copy of it into a
fresh directory with the dependencies pointed at the registry, so
`pnpm create @rotorsoft/act-app my-app` produces something that builds, tests,
and runs without the monorepo around it.

## Public surface added

This is a **new published package** plus the **contract of what it generates** —
the generated project shape is itself a public surface, because people will build
on it and expect it to stay sane across versions.

- **New package** — `@rotorsoft/create-act-app` (the `pnpm create` / `npm init`
  naming convention resolves `create @rotorsoft/act-app` to this). Published to
  npm with a `bin`. Like the other adapters it needs a seeded `0.0.0` baseline
  tag before first merge so semantic-release doesn't jump to `1.0.0`.
- **CLI surface** — the invocation and its flags, e.g.
  `pnpm create @rotorsoft/act-app <dir> [--store inmemory|sqlite|pg] [--api none|trpc|hono] [--no-install] [--no-git]`.
  Exact flags are an open question; the *fact* that they're a stable contract is
  the point.
- **Generated project contract** — what a scaffolded app contains: one `state` +
  one `slice` + one `projection`, a chosen `Store`, a passing test, a README, and
  (optionally) a tRPC/hono surface. This tracks the live `@rotorsoft/act` public
  API; when the API moves, the template moves with it.

No change to `@rotorsoft/act` or any existing package's surface — this is purely
additive, a new leaf tool that depends on the published framework.

## Alternatives considered

- **Do nothing — point people at the examples + a docs guide.** Cheapest, and the
  `scaffold-act-app` skill already helps Claude-assisted users. Rejected as the
  whole answer: it doesn't help a human at a terminal who just wants to start, and
  the manual copy-and-repoint dance is exactly the friction this removes.
- **A `degit`-style template repo** (`npx degit rotorsoft/act-template my-app`).
  Simple, no code to maintain. Rejected as primary because it can't prompt for a
  store/API choice, can't run install, and a template repo drifts from the
  framework silently (nothing type-checks it against the live API). A generated
  app from an in-repo template that compiles in CI stays honest.
- **Generate from scratch with a template engine** rather than trimming an
  existing example. Rejected — it duplicates the calculator model in a second
  place that can rot. Reusing the already-tested example as the template source
  keeps one source of truth.
- **Fold it into the existing `act` CLI** (`act new`). Plausible, but `act` ships
  from `@rotorsoft/act-diagram` and is a contracts inspector; a scaffolder is a
  different concern with a different dependency profile (it must run standalone,
  before any Act packages are installed). Keep them separate.

## Stability / charter impact

- **Category:** new package + a CLI/generated-output contract. Not covered by the
  current [STABILITY.md](../STABILITY.md) charter (which governs the core
  packages), but the generated-project shape and CLI flags should get their own
  stability note once the surface settles — breaking the generated layout is a
  user-visible break.
- **Additive.** Nothing existing changes; ships as a new package on its own
  version line. Follow [contributing-new-package.md](../docs/docs/guides/contributing-new-package.md):
  seed the baseline tag, add a `stability.spec.ts` if any of its surface is
  importable, wire it into CI.
- **No port / `IAct` / builder change**, so no TCK or adapter work.
- **CI:** the generated app must be smoke-tested in CI (scaffold it, install,
  build, test) so the template can't drift from the live API — this is the
  mechanism that makes the "generated project contract" real rather than
  aspirational.

## Open questions

1. **Template source.** Reuse `packages/calculator` as the trimmed template, or
   author a dedicated minimal template? Reuse keeps one source of truth but the
   calculator carries demo code (rebuild/close) a starter doesn't need.
2. **Prompts vs. flags.** Interactive prompts (store, API surface), pure flags,
   or both with sensible defaults for a zero-prompt `pnpm create @rotorsoft/act-app my-app`?
3. **API surface options.** Offer tRPC / hono / openapi / none? How much of the
   `act-http` auto-generated API to wire into the starter without overwhelming it.
4. **Monorepo vs. single package.** Scaffold a single runnable package by default,
   or a small workspace? Single package is the simpler "hello world"; a workspace
   matches how real Act apps grow.
5. **Versioning the template against the framework.** Pin the generated app to the
   `@rotorsoft/act` version that matches the scaffolder's release, or always
   `latest`? Pinning is reproducible; `latest` avoids stale starters.
