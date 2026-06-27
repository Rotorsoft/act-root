# Migrating between major versions

This file is the index of per-release migration guides for Act. Every **breaking**
release (a major version bump under the [Stability Charter](STABILITY.md)) ships a
migration page that tells users exactly what changed and how to update their code.

> Patch and minor releases never break the public surface, so they don't get a
> migration page. Look here only when a major version bumps.

## Where the guides live

Each major release gets its own page in the versioned documentation site, so the
guide stays pinned next to the API reference it describes:

- `docs/docs/guides/migrating-to-<major>.md` — authored against the **current**
  (unreleased) docs while the breaking change lands, then snapshotted into
  `docs/versioned_docs/version-<line>/` when the release is cut.

The Docusaurus version dropdown lets a user reading the old `1.x` docs jump
straight to the `2.x` migration page, and vice-versa.

## Available guides

<!-- Add a row here in the same PR that lands the breaking change. -->

| From → To | Guide | Highlights |
|---|---|---|
| _none yet_ | — | The `1.x` line is the first versioned snapshot; no breaking migration has shipped. |

## Writing a migration guide (the convention)

When a PR introduces a breaking change (it carries a `BREAKING CHANGE:` commit
footer — see the [Stability Charter](STABILITY.md)), the **same PR** adds the
migration guide. Use this template:

```markdown
---
title: Migrating to <major> (e.g. 2.x)
---

# Migrating to <major>

> Applies to: `@rotorsoft/act@<old>` → `@rotorsoft/act@<new>` (and the adapters
> that track core — see the per-library table in STABILITY.md).

## TL;DR

A two-or-three line summary of what broke and the shortest path to update.

## Breaking changes

For each breaking change, one subsection:

### <short title of the change>

- **What changed** — the old shape vs. the new shape.
- **Why** — one sentence; link the issue/PR.
- **How to update** — a before/after code block.

\`\`\`ts
// before (<old version>)
...

// after (<new version>)
...
\`\`\`

## Deprecations (not yet removed)

Anything shipping a deprecation alias this release that will be removed next major.

## Nothing-to-do

Call out the surfaces that did **not** change, so readers can stop early.
```

### Checklist for the release PR

- [ ] Commit carries a `BREAKING CHANGE:` footer (drives the major bump).
- [ ] `docs/docs/guides/migrating-to-<major>.md` added and linked from
      `docs/sidebars.ts` (Guides category).
- [ ] A row added to the **Available guides** table above.
- [ ] The previous line is snapshotted with
      `pnpm --filter docs exec docusaurus docs:version <line>` **before** the
      breaking edits land in `docs/docs/`, so the pinned older docs stay accurate.
- [ ] Release notes / changelog reference the migration guide.

See [STABILITY.md](STABILITY.md) for what counts as breaking in each category.
