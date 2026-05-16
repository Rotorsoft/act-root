---
description: Open a pull request with the project's canonical body shape
argument-hint: "[ticket #]"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*)
---

Open a pull request for the current branch following the Act project conventions.

## Steps

1. Verify the branch is clean and pushed (`git status`, `git log origin/$(git rev-parse --abbrev-ref HEAD)..HEAD`). If unpushed commits exist, push them with `-u`.
2. If `$ARGUMENTS` includes a ticket number, plan to use `Closes #<num>` in the PR body. Otherwise omit (don't fabricate).
3. Run `git log master..HEAD --oneline` and `git diff master...HEAD --stat` to identify the full scope of the branch.
4. Compose the PR body with these sections, in order:
   - **Title** — under 70 chars, conventional-commits format matching the dominant commit type on the branch.
   - **Summary** — `Closes #N.` if applicable, then a one-paragraph "what shipped + why" in plain prose.
   - **Sections per concern** — each major change gets its own `##` section with the rationale, not just the diff.
   - **Test plan** — Markdown checkbox list. Pre-tick items already verified locally (typecheck, test, lint, coverage). Leave CI/review boxes unchecked.
   - **Stability charter impact** — call out additive vs. breaking with files touched. Skip the section only if no charter-covered files changed.
   - **Follow-ups** — parked work referenced as separate tickets.
5. Open with `gh pr create --title ... --body "$(cat <<'EOF' ... EOF)"` and HEREDOC the body so Markdown formatting survives.
6. Print the resulting URL.

## Conventions

- **Coverage line is required** when libs/ changed. Format: `Coverage: 100% statements / 100% branches / 100% functions / 100% lines.`
- **Co-Author trailer** stays — the project credits Claude as a contributor.
- **Do NOT use auto-merge.** The user merges manually after CI.
- **`Closes #N`** uses the actual GitHub issue number, not the project key (`ACT-604`). The auto-close hook only recognizes `#`.
