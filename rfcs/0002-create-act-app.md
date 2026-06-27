# RFC 0002: create-act-app scaffolder

- **Status:** rejected <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1037
- **Author:** rotorsoft
- **Created:** 2026-06-27

## Resolution

**Rejected** (open question 6 settled). Act's scaffolding story is **AI-first**:
the `scaffold-act-app` skill turns a spec into a tailored, working app, and that
is the supported front door. A deterministic `pnpm create @rotorsoft/act-app`
package would be a maintained, drift-prone surface serving only the narrow
un-assisted slice — not worth its keep against the skill plus the existing
examples. Non-AI users are served by the examples and a "start from an example"
docs path, not a generated-template package. The analysis below is kept as the
record of why.

## Motivation

Act already has a scaffolding path, and a good one: the **`scaffold-act-app`
Claude skill** turns a functional spec — event-modeling diagrams, event-storming
artifacts, user stories — into a working monorepo with domain logic, a tRPC API,
a React client, SSE wiring, and tests. For anyone building with Claude Code that
is the front door, and it is more capable than any fixed template could be,
because it adapts to the user's actual domain.

What's missing is the **AI-free, deterministic, single-command** path: a
developer at a terminal, not using Claude, who just wants the `npm create` muscle
memory — `pnpm create @rotorsoft/act-app my-app` → a minimal app that builds,
tests, and runs. Today that person clones the monorepo, finds an example under
`packages/`, copies it out, strips the workspace wiring, repoints `workspace:*`
deps to published versions, and deletes the demo parts. The frameworks Act
competes with for attention all ship this (`npm create vite`, `create-next-app`)
precisely because the gap between "this looks interesting" and "it's running" is
where un-assisted evaluations are lost.

So the two are complementary, not redundant: the skill is **spec-driven and
AI-assisted**, producing a tailored app; this would be a **fixed, reproducible,
zero-AI starter** that runs without Claude and without the monorepo. We already
have the raw material — the `calculator` example is a complete, tested, runnable
app to trim from. Whether that second path is worth a *maintained package* (vs.
leaving non-AI users to the examples plus a docs guide) is the real question this
RFC exists to settle — see Open questions.

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

- **Do nothing — the `scaffold-act-app` skill plus the examples already cover
  it.** This is the strongest alternative and must be taken seriously. The skill
  fully serves AI-assisted users (spec → tailored app), and a good
  "getting started from an example" docs page could serve much of the non-AI
  audience. If we judge the remaining un-assisted, zero-config terminal start to
  be a thin slice, a maintained `create-` package may not earn its keep —
  scaffolders rot against the framework and need their own release line and CI.
  The case *for* building it is reach: the `npm create` path is the convention
  un-assisted evaluators expect, and it works with no AI in the loop. This RFC
  does not assume the answer; question 6 makes it the explicit decision.
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
6. **Is it worth a maintained package at all, given the skill?** The gating
   decision. The `scaffold-act-app` skill already covers AI-assisted starts. Does
   the un-assisted, deterministic `pnpm create` path add enough reach to justify a
   new package with its own release line and drift-prevention CI — or is a
   "start from an example" docs guide sufficient for non-AI users? Settle this
   before any of the above.
