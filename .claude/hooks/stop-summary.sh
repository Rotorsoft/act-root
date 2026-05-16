#!/usr/bin/env bash
# Stop hook fired when the model is about to end its turn.
#
# Surfaces the operational state of the working tree so the model can
# notice "I changed code but didn't run tests" before saying "done."
# Never blocks — purely informational. Output goes to the transcript.
set -o pipefail

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0

# Count staged and unstaged TS source changes in libs/ or packages/.
# Tests, docs, and config don't trigger the coverage-reminder line.
src_changed="$(git diff --name-only HEAD -- 'libs/**/*.ts' 'packages/**/*.ts' 2>/dev/null | wc -l | tr -d ' ')"
test_changed="$(git diff --name-only HEAD -- 'libs/**/*.spec.ts' 'libs/**/*.bench.ts' 'packages/**/*.spec.ts' 2>/dev/null | wc -l | tr -d ' ')"

# Most recent coverage summary, if vitest left one behind.
cov_summary=""
if [[ -f coverage/coverage-summary.json ]]; then
  cov_summary="$(jq -r '.total | "stmts \(.statements.pct)% / branches \(.branches.pct)% / funcs \(.functions.pct)% / lines \(.lines.pct)%"' coverage/coverage-summary.json 2>/dev/null || echo "")"
fi

# Compose a short status line. Only print when there's actually something
# to say — silence is the right default when nothing changed.
lines=()
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [[ -n "$branch" && "$branch" != "master" ]]; then
  lines+=("branch: $branch")
fi
if [[ "$src_changed" -gt 0 || "$test_changed" -gt 0 ]]; then
  lines+=("changed: ${src_changed} src + ${test_changed} test")
fi
if [[ "$src_changed" -gt 0 && "$test_changed" -eq 0 ]]; then
  lines+=("⚠ src changed but no test changed — verify coverage")
fi
if [[ -n "$cov_summary" ]]; then
  lines+=("last coverage: $cov_summary")
fi

if [[ ${#lines[@]} -eq 0 ]]; then
  exit 0
fi

# Stop hooks don't accept hookSpecificOutput.additionalContext (that's
# UserPromptSubmit / SessionStart territory). Emit `systemMessage` so
# the line shows up in the transcript without claiming a decision.
printf '%s\n' "${lines[@]}" | jq -Rs '{ systemMessage: . }'
