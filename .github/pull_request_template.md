<!--
Follow the canonical body shape in .claude/commands/pr.md:
Summary → sections per concern → Test plan → Stability charter impact.
Use `Closes #N` with the GitHub issue number (not the project key).
-->

## Summary

<!-- Closes #N. One paragraph: what shipped + why. -->

## Test plan

<!-- CI checks typecheck, lint, tests with 100% coverage, build and the stability snapshot. List only what you checked beyond that (a manual run, a probe, a docs build). -->

## Stability charter impact

<!-- Additive vs. breaking, with files touched. Skip if no charter-covered files changed. -->

- [ ] This PR adds new public surface (export, builder method, port method, or lifecycle event) and links an [RFC](../rfcs/README.md) — or it adds none.
