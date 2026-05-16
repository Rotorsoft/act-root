#!/usr/bin/env bash
# UserPromptSubmit hook — fired before the model sees a new prompt.
#
# Injects lightweight operational context: current branch, uncommitted
# file count, open-PR-on-this-branch hint. This is the closest thing to
# "ambient awareness" — Claude can tell whether you're mid-PR or fresh
# on master without asking.
#
# Cheap (no network calls); times out at 5s in settings.
set -o pipefail

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[[ -z "$branch" ]] && exit 0

# Two simple counts that change what "the right next step" looks like.
uncommitted="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
ahead="$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo "0")"

bits=("branch=$branch")
[[ "$uncommitted" != "0" ]] && bits+=("uncommitted=$uncommitted files")
[[ "$ahead" != "0" ]] && bits+=("unpushed=$ahead commits")

# Join with " · " for a one-line readout.
ctx="$(IFS=' · '; echo "${bits[*]}")"

jq -n --arg ctx "$ctx" '{
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: $ctx }
}'
