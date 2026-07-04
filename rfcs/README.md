# RFCs

[STABILITY.md](../STABILITY.md) is the contract for what semver protects, and the
`runStabilityTck` snapshot in every package catches *changes* to that surface in a
PR diff. Neither gates *additions*. A new export, builder method, port method, or
lifecycle event ships the moment a PR merges — and from that moment it's covered by
the charter and expensive to take back. This folder is the lightweight gate in
front of that one-way door: before new public surface calcifies, write down why it
exists, what exactly it adds, and what you rejected.

It is deliberately small. An RFC is a one-page design note, not a specification or
an approval committee. The point is to make the author think the addition through
in the open — and to leave behind the *why* and the *rejected designs*, the part
that disappears from the diff once the code merges.

## When an RFC is required

Open an RFC for any PR that **adds new public surface**, namely:

- a new public **export** from `@rotorsoft/act` or any `@rotorsoft/act-*` entry point or subpath;
- a new **builder method** on `state` / `slice` / `projection` / `act`;
- a new **port method** on `Store` / `Cache` / `Logger`;
- a new **lifecycle event** name or payload shape on the public bus.

These are the surfaces enumerated in [STABILITY.md § Covered by semver](../STABILITY.md#covered-by-semver).

## When an RFC is *not* required

- Bug fixes, refactors, and performance work that don't change the public surface.
- Anything under `internal/`, adapter implementation details, log formats, or other
  surface listed in [STABILITY.md § Not covered](../STABILITY.md#not-covered).
- New **optional fields** on an existing options bag, or a new **event version**
  (`Foo` → `Foo_v2`) — these are additive by the charter's own rules and don't need
  an RFC, though one is welcome if the design is non-obvious.
- Docs, recipes, examples, and tooling under `packages/`, `recipes/`, `docs/`, or `scripts/`.
- Stability-snapshot growth that adds no surface — the snapshot embeds internal
  module source text, so a longer log line or comment can trip the gate's line
  counter. Declare `rfc-gate: exempt — <reason>` in the PR body; the gate accepts
  the marker and the reviewer audits the claim against the snapshot diff.

When in doubt, open the RFC — it's a page, and the reviewer would rather read it
than reverse-engineer the intent later.

## Process

1. Copy [`0000-template.md`](0000-template.md) to `rfcs/NNNN-<slug>.md`, where `NNNN`
   is the PR number (or the issue number if you open the RFC first). Fill in every section.
2. Open the PR with the implementation, or RFC-first if you want design sign-off
   before writing code. Either way, **the PR that adds the surface links the RFC**.
3. The PR checklist (see [`.github/pull_request_template.md`](../.github/pull_request_template.md))
   carries the one-line confirmation that surface-adding PRs include an RFC link.
4. Mark the RFC `accepted` when the PR merges; `rejected` or `superseded` otherwise.

This complements, not replaces, the rest of the pre-handoff workflow in
[CLAUDE.md](../CLAUDE.md) — the 100% coverage gate, the book-note essay (which
captures narrative design history for *substantive* tickets), and the doc audit
still apply.
