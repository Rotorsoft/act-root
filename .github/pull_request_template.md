<!--
Follow the canonical body shape in .claude/commands/pr.md:
Summary → sections per concern → Test plan → Stability charter impact → Follow-ups.
Use `Closes #N` with the GitHub issue number (not the project key).
-->

## Summary

<!-- Closes #N. One paragraph: what shipped + why. -->

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm test` (100% statements / branches / functions / lines)
- [ ] `pnpm lint`

## Stability charter impact

<!-- Additive vs. breaking, with files touched. Skip if no charter-covered files changed. -->

- [ ] This PR adds new public surface (export, builder method, port method, or lifecycle event) and links an [RFC](../rfcs/README.md) — or it adds none.
