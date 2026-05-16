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

# Identify the package that owns the file. The package root is the
# nearest ancestor with a tsconfig.json — fall back to silent skip when
# we can't locate one.
file_dir="$(dirname "$file_path")"
pkg_dir="$file_dir"
while [[ "$pkg_dir" != "/" && ! -f "$pkg_dir/tsconfig.json" ]]; do
  pkg_dir="$(dirname "$pkg_dir")"
done
if [[ "$pkg_dir" == "/" ]]; then
  exit 0
fi

# Run the package's typecheck. We use --noEmit and rely on TS's
# incremental build cache (tsbuildinfo) so repeat invocations are fast.
# stderr is captured separately so we can surface compile errors clearly.
cd "$pkg_dir" || exit 0
output="$(npx tsc --noEmit -p tsconfig.json 2>&1)"
exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  # Trim to the first 40 lines so the model doesn't drown in cascading
  # errors — the root cause is almost always in the first one.
  trimmed="$(printf '%s\n' "$output" | head -40)"
  jq -n \
    --arg reason "TypeScript errors in $(basename "$pkg_dir") after editing ${file_path##*/}:
$trimmed
Fix before continuing." \
    '{decision: "block", reason: $reason}'
  exit 0
fi

exit 0
