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

## Wire the package into the repo

| File | What to add |
|---|---|
| `.github/workflows/ci-cd.yml` | Add the package name to the `cd` job matrix so semantic-release runs against it |
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
