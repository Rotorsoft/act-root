---
description: Walk through the contributing-new-package.md workflow for adding a new @rotorsoft/act-* package
argument-hint: "<package-name>"
allowed-tools: Bash(git:*), Bash(pnpm:*), Read, Write
---

Scaffold a new `@rotorsoft/act-*` package under `libs/` following `docs/docs/guides/contributing-new-package.md`. The user provides the package suffix (e.g., `mongo` → `@rotorsoft/act-mongo`).

## Critical first step

**Push the baseline tag BEFORE the first PR merges to master.** Without it, semantic-release defaults the first release to `1.0.0` regardless of `package.json`. The tag goes on a master commit (or just before the feature branch diverged):

```bash
git tag @rotorsoft/act-$ARGUMENTS-v0.0.0 <commit-on-master>
git push origin @rotorsoft/act-$ARGUMENTS-v0.0.0
```

Verify with `git ls-remote --tags origin | grep act-$ARGUMENTS`.

## Scaffolding checklist (in order)

1. **Baseline tag** — pushed above. First `feat(act-$ARGUMENTS):` commit will cut `0.1.0`.
2. **Directory structure** — `libs/act-$ARGUMENTS/{src,test}/`, mirror `libs/act-sse/` shape.
3. **`package.json`** — copy from `act-sse` or `act-http`. Update name, version (`0.0.0`), description, keywords, peer-deps on `@rotorsoft/act` if it's an adapter.
4. **`tsconfig.json` + `tsconfig.build.json`** — copy from a sibling, update `references`.
5. **`tsup.config.ts`** — copy from sibling. Adjust `entry` if subpath exports.
6. **`.releaserc.json`** — copy from sibling, update `tagFormat` to `@rotorsoft/act-$ARGUMENTS-v${version}`.
7. **`README.md`** — narrative explaining what the package does, when to use it, and when NOT to. Match the tone of the existing READMEs (no AI patterns).
8. **`CHANGELOG.md`** — empty file, `# Changelog`. Semantic-release will populate.
9. **Repo wiring (the easily-forgotten checklist):**
   - `.github/workflows/ci-cd.yml` libs filter — add `act-$ARGUMENTS: ['libs/act-$ARGUMENTS/**']`
   - **`pnpm paths:sync`** — regenerates `tsconfig.workspace.json` paths from package `exports`; CI runs `pnpm paths:check` and fails without it (bit act-notify in #1172)
   - `vite.config.ts` — add alias if tests need it
   - `packages/tsconfig.base.json` — add path mapping if packages will import the new lib
   - `README.md` (root) — one-line entry under Libraries (Core or Supporting)
   - `CLAUDE.md` — one-line under `/libs` structure list
   - `docs/sidebars.ts` — API Reference link
   - `docs/typedoc.json` — entry point
   - `docs/tsconfig.json` — path mapping + include
10. **Optional: scaffold-act-app skill** — if the new package is part of the recommended app stack, update the relevant skill files.

## What to remember after scaffolding

- **Conventional commit subject must be lowercase.** `feat(act-mongo): ...` not `feat(act-mongo): MongoDB...`
- **Don't manually bump `version`** in package.json. Semantic-release owns it. The seed tag at `0.0.0` is the only manual version event.
- If it's a `Store` / `Cache` / `Logger` adapter, **run the TCK against it** in the package's own test suite (capability-gated for features the adapter doesn't implement).

## Reference

See `docs/docs/guides/contributing-new-package.md` for the canonical version of this checklist.
