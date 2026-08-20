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

     **Decide the `rfc-gate` line here, before opening the PR — not after CI fails.** The gate fires whenever the stability snapshot *grows*, and that snapshot captures **source text**, so a new doc comment or an internal helper trips it even though nothing public changed. Any PR touching `libs/*/src` should assume it will fire.

     - Genuinely adds public surface (new export, builder method, port method, lifecycle event, new field on an exported type) → the PR needs an `rfcs/NNNN-*.md`, linked in the body.
     - Snapshot grew but no public surface was added → put `rfc-gate: exempt — <why>` in the body **at creation time**, naming what actually grew (comments, an internal parameter, a private helper).

     Reactively editing the body after a red gate has cost a CI cycle on four PRs; the decision is knowable before pushing.
   - **Follow-ups** — parked work referenced as separate tickets.
5. Open with `gh pr create --title ... --body "$(cat <<'EOF' ... EOF)"` and HEREDOC the body so Markdown formatting survives.
6. Print the resulting URL.

## Write it in plain language

A PR body is read by a person deciding whether to merge, often months later and
often not holding the context you have right now. Write for that person.

**Open with one plain sentence saying what actually happened.** Not "this PR
refactors the correlate checkpoint to be durable" — that's the diff restating
itself. Something a reader can act on: "a restart could silently skip work, and
this stops that."

**Every PR answers four questions, in this order:**

1. **What did we do?** In words, not method names.
2. **What did we find?** Especially if it contradicts something we already
   published — say so directly and prominently, don't bury the correction.
3. **What does it cost?** New risks, new limitations, things we still can't
   answer. A PR with no cost section usually means the cost wasn't looked for.
4. **What do we recommend?** What should someone reading this actually do.

**Concretely:**

- **Explain the number, don't just print it.** "0.85×" is a ratio the reader has
  to decode and get the direction right. "11–15% faster" is the finding.
- **Spell out the jargon or drop it.** Terms like group commit, HOT updates,
  fsync amortization, MVCC churn and watermark are fine in `PERFORMANCE.md` and
  in code comments. In a PR body, either explain them in a clause or describe
  the effect instead: "how databases batch writes to disk."
- **Prose over tables for reasoning.** Tables are for measurements. A table of
  hypotheses-and-verdicts is a lab notebook — say "we checked four explanations
  and ruled out every one," then name them in a sentence.
- **Lead with the correction when something we published was wrong.** It goes
  near the top, in its own section, stated flatly. Never let it read as a
  footnote to a success story.
- **State what you could not determine.** "No benchmark on one machine can
  answer this" is a real deliverable. Silence reads as a claim.

The test: someone who doesn't know this subsystem should be able to read the
body and correctly say what changed, what it cost, and what to do about it. If
they'd need to open the diff to get that, rewrite the body.

## Conventions

- **Coverage line is required** when libs/ changed. Format: `Coverage: 100% statements / 100% branches / 100% functions / 100% lines.`
- **Co-Author trailer** stays — the project credits Claude as a contributor.
- **Do NOT use auto-merge.** The user merges manually after CI.
- **`Closes #N`** uses the actual GitHub issue number, not the project key (`ACT-604`). The auto-close hook only recognizes `#`.
