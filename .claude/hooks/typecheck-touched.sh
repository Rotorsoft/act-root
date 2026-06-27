#!/usr/bin/env bash
# PostToolUse hook fired after Edit/Write.
#
# Goal: catch TypeScript errors at the moment they're introduced, not at
# the next `pnpm typecheck` an hour later. We use a per-package incremental
# tsc rather than the full monorepo build — the workspace-wide typecheck
# is too slow (~30s) to gate every edit.
#
# Scope: only fire when a tracked TS source file changed under libs/ or
# packages/. Other paths (.md, .json, generated files) are silent passes.
#
# Output: structured JSON Claude can read. On failure we emit a
# `reason` so the model can correct the type error before doing more
# work.
set -uo pipefail

# Hook payload arrives on stdin as JSON: { tool_input: { file_path: ... } }.
# Bail safely if jq is missing or the payload is malformed — never block
# a real edit because of hook plumbing.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

payload="$(cat 2>/dev/null || echo '{}')"
file_path="$(echo "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"

# Only care about TS sources under libs/ or packages/. Skip declaration
# files, generated dist files, test fixtures we don't own.
case "$file_path" in
  */dist/*|*.d.ts|*node_modules*)
    exit 0 ;;
  *libs/*.ts|*packages/*.ts|*libs/*.tsx|*packages/*.tsx)
    : ;;  # fall through to typecheck
  *)
    exit 0 ;;
esac

# Repo root holds tsconfig.workspace.json, whose `paths` map @rotorsoft/*
# and @act/* to source. Type-checking against it resolves cross-package
# imports to `src`, so a freshly edited file checks without any dependency
# being built first — the per-package config used composite `references`,
# which forced resolution through built `dist` and blocked every edit in a
# not-yet-built tree (the recurring TS6305 papercut).
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$root/tsconfig.workspace.json" ]] || exit 0

# Identify the package that owns the file (nearest ancestor with a
# tsconfig.json) — used to scope which errors we surface.
file_dir="$(dirname "$file_path")"
pkg_dir="$file_dir"
while [[ "$pkg_dir" != "/" && ! -f "$pkg_dir/tsconfig.json" ]]; do
  pkg_dir="$(dirname "$pkg_dir")"
done
if [[ "$pkg_dir" == "/" ]]; then
  exit 0
fi
pkg_rel="${pkg_dir#"$root"/}"

# Type-check the whole workspace project (--noEmit). An incremental cache
# keeps repeat invocations fast after the first run; the cache lives under
# the already-ignored .claude/.cache/.
cache_dir="$root/.claude/.cache"
mkdir -p "$cache_dir"
cd "$root" || exit 0
output="$(npx tsc --noEmit --incremental \
  --tsBuildInfoFile "$cache_dir/typecheck-workspace.tsbuildinfo" \
  --project tsconfig.workspace.json --jsx react-jsx 2>&1)"

# Surface only errors in the edited file's package — the hook's job is to
# catch what this edit just broke, not pre-existing errors elsewhere. tsc
# prints repo-relative paths because it runs from the root.
pkg_errors="$(printf '%s\n' "$output" | grep -E "^${pkg_rel}/" || true)"

if [[ -n "$pkg_errors" ]]; then
  # Trim to the first 40 lines so the model doesn't drown in cascading
  # errors — the root cause is almost always in the first one.
  trimmed="$(printf '%s\n' "$pkg_errors" | head -40)"
  jq -n \
    --arg reason "TypeScript errors in ${pkg_rel} after editing ${file_path##*/}:
$trimmed
Fix before continuing." \
    '{decision: "block", reason: $reason}'
  exit 0
fi

exit 0
