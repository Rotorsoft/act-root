---
id: contributing-new-package
title: Contributing a new package
---

# Contributing a new package

When you add a brand-new library to `/libs` (e.g., `@rotorsoft/act-foo`), the release pipeline needs a baseline tag *before* the first PR merges to `master`. Without it, `semantic-release` defaults the very first release to `1.0.0` regardless of what's in `package.json`.

## Seed the baseline tag first

On the feature branch, before opening or merging the first PR:

```bash
git tag @rotorsoft/act-foo-v0.0.0 <commit-on-master-or-pre-feature>
git push origin @rotorsoft/act-foo-v0.0.0
```

Pick a commit on `master` (or just before the feature branch diverged). This tag becomes the "last release" semantic-release compares against, so the first real release on `master` increments from `0.0.0` per conventional-commit prefixes.

## Export source locally, build output on publish

Point `exports` at the package's **source**, and put the `dist` entries under `publishConfig.exports`:

```json
{
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts" }
  },
  "publishConfig": {
    "access": "public",
    "exports": {
      ".": {
        "types": "./dist/@types/index.d.ts",
        "import": "./dist/index.js",
        "require": "./dist/index.cjs"
      }
    },
    "main": "./dist/index.cjs",
    "module": "./dist/index.js",
    "types": "./dist/@types/index.d.ts"
  }
}
```

pnpm swaps the two at publish time, so the package on npm advertises `dist` exactly as before. In the workspace it advertises source, which is what makes every tool — vitest, `tsc`, `node` — resolve a sibling `@rotorsoft/*` import to `src/` from any working directory, with no per-package tool config.

Get this wrong and the failure is quiet: a package that advertises `dist` locally sends siblings to build output, so a `vitest` run inside the package directory tests yesterday's build and **passes while doing it** ([#1676](https://github.com/Rotorsoft/act-root/issues/1676)). `pnpm check:exports` enforces the shape, and CI runs it — including that no top-level `main` / `module` / `types` is left behind to contradict `exports`.

Copy the shape from a sibling (`act-patch` is the smallest) rather than from an older template.

## Wire the package into the repo

| File | What to add |
|---|---|
| `.github/workflows/ci-cd.yml` | Add the package name to the `cd` job matrix so semantic-release runs against it |
| `tsconfig.workspace.json` | Run `pnpm paths:sync` — paths derive from package `exports`, and CI's `pnpm paths:check` fails until the new package is registered |
| `libs/act-foo/.releaserc.json` | Copy from a sibling lib (`act-pg`, `act-sqlite`) and update `tagFormat` to match the new package |
| `README.md` (root) | Add a one-line entry under the libraries section pointing at the package |
| `CLAUDE.md` (root) | Add a one-line entry under "Project Structure / libs" |
| `docs/sidebars.ts` | Add an "API Reference" link to `/docs/api/act-foo/src` |
| `docs/typedoc.json` | Add the package's entry point so typedoc generates API docs |
| `docs/tsconfig.json` | Add the package path so typedoc can resolve types |
| `.claude/skills/scaffold-act-app/*.md` | If the new package is part of the recommended app stack (store, cache, broadcast, etc.), reference it from the relevant skill files |

## Conventional commits and the first release

The `cd` workflow runs semantic-release per package after merge. The first release on `master` uses the seed tag as the comparison base:

- `feat(act-foo): ...` → `0.1.0`
- `fix(act-foo): ...` → `0.0.1`
- `feat(act-foo)!: ...` or `BREAKING CHANGE:` → `1.0.0`

Without the seed tag, the first commit always cuts `1.0.0`. With the seed tag, packages can ship as `0.x` releases until they're stable.

## Don't bump versions manually

Never edit `version` in `package.json` by hand. Semantic-release owns the version field — manual bumps create diffs that conflict with the auto-bump commit.

## Adapter packages — implement the contract

If the new package is a `Store`, `Cache`, or `Logger` adapter, make sure it implements every invariant in [Extension points](../architecture/extension-points). Reuse the multi-process stress harness in `libs/act-pg/test/stress/` as a template — it exercises the contract under contention and catches most bugs an adapter author would otherwise hit in production.
