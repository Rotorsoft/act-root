#!/usr/bin/env bash
# Simplicity metrics for the Act core. Prints one markdown block; run from the
# repo root. Compare against the previous entry in history.md.
set -euo pipefail
SRC=libs/act/src
files() { find "$SRC" -name '*.ts'; }

lines=$(files | xargs cat | wc -l | tr -d ' ')
comments=$(files | xargs cat | grep -cE '^\s*(//|\*|/\*)' || true)
code=$((lines - comments))
tickets=$(files | xargs cat | { grep -oE '#[0-9]{3,4}|ACT-[0-9]+' || true; } | wc -l | tr -d ' ')
over300=$(files | xargs wc -l | awk '$2!="total" && $1>300' | wc -l | tr -d ' ')
exports=$(node -e "import('./libs/act/dist/index.js').then(m=>console.log(Object.keys(m).length)).catch(()=>console.log('n/a (build first)'))")
iact=$(awk '/^export interface IAct</,/^}/' $SRC/types/action.ts | grep -cE '^  [a-z_]+[<(]' || true)
act_public=$(grep -E '^  (async )?[a-z][a-z_]*(<[^>]*>)?\(' $SRC/act.ts | grep -cv 'constructor' || true)
store=$(awk '/^export interface Store/,/^}/' $SRC/types/ports.ts | grep -cE '^  [a-z_]+\??:' || true)
act_options=$(awk '/^export type ActOptions/,/^};/' $SRC/act.ts | grep -cE '^  (readonly )?[a-zA-Z]+\??:' || true)

echo "| metric | value |"
echo "|---|---|"
echo "| core lines (libs/act/src) | $lines |"
echo "| code lines / comment lines | $code / $comments ($((comments * 100 / lines))% comments) |"
echo "| ticket refs in source | $tickets |"
echo "| files over 300 lines | $over300 |"
echo "| runtime exports (@rotorsoft/act) | $exports |"
echo "| IAct methods / Act class public methods | $iact / $act_public |"
echo "| Store port methods | $store |"
echo "| ActOptions fields | $act_options |"

# Beyond the core: tests, packages, infra, docs.
specs=$(git ls-files '*.spec.ts' | wc -l | tr -d ' ')
test_lines=$(git ls-files '*.spec.ts' | xargs cat | wc -l | tr -d ' ')
lib_lines=$(git ls-files 'libs/*/src/*.ts' 'libs/*/src/**/*.ts' | xargs cat | wc -l | tr -d ' ')
ticket_tests=$(git ls-files '*.spec.ts' | xargs grep -hE '(it|describe|test)\(.*(#[0-9]{3,4}|ACT-[0-9]+)' | wc -l | tr -d ' ' || true)
packages=$(git ls-files 'libs/*/package.json' | wc -l | tr -d ' ')
workflows=$(ls .github/workflows/*.yml | wc -l | tr -d ' ')
workflow_lines=$(cat .github/workflows/*.yml | wc -l | tr -d ' ')
doc_lines=$(find docs/docs -name '*.md' -not -path '*/api/*' | xargs cat | wc -l | tr -d ' ')
claude_md=$(( $(wc -c < CLAUDE.md) / 1024 ))

echo "| spec files / test lines (all libs: $lib_lines src lines) | $specs / $test_lines |"
echo "| test names citing tickets | $ticket_tests |"
echo "| published packages (libs/) | $packages |"
echo "| CI workflows / lines | $workflows / $workflow_lines |"
echo "| docs lines (excl. generated API) / CLAUDE.md KB | $doc_lines / $claude_md |"
echo
echo "Largest files:"
files | xargs wc -l | sort -rn | sed -n '2,8p' | awk '{printf "- %s (%s)\n", $2, $1}'
