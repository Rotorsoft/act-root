# `.claude/` — Claude Code configuration

This directory is the project's Claude Code surface: hooks, slash commands, subagents, skills, and permission defaults. Everything here is **committed to git**, so every contributor's Claude session boots with the same guardrails and workflow shortcuts.

For machine-specific overrides, use `settings.local.json` (gitignored).

## Layout

```
.claude/
├── README.md              ← you are here
├── settings.json          ← committed defaults: permissions + hooks
├── settings.local.json    ← gitignored: personal overrides
├── agents/                ← subagent definitions
├── commands/              ← slash commands
├── hooks/                 ← shell scripts run by hooks declared in settings.json
└── skills/                ← skills auto-loaded when triggered
```

## `settings.json` — what's committed

Two concerns are encoded here:

### Permissions

A deliberately narrow allowlist for what's needed to **work on the framework itself**: `pnpm:*`, `git:*` (with destructive ops explicitly denied), `gh:*` (same), common file utilities, and `WebFetch` for the project's own docs, GitHub source, and npm registry.

What's **not** in the committed allowlist by design:

- `WebSearch` — auto-allowing arbitrary search results would surface any URL on any topic. Personal browsing belongs in `settings.local.json`.
- Research / blog / tool domains (`event-driven.io`, `martendb.io`, `typst.app`, etc.) — individual preferences, not project requirements.
- Broad `Bash(curl:*)` — narrowed to `localhost`, `127.0.0.1`, `api.github.com`, and `registry.npmjs.org`. Other URLs prompt.

The `deny` block enforces a safety floor that wildcards in `allow` can't override: force-pushes, history rewrites, `gh repo delete`, `npm publish`, catastrophic `rm -rf /` patterns, `--no-verify` on commit/push.

Need a wider surface for your own workflow? Add to `settings.local.json` (gitignored):

```jsonc
// .claude/settings.local.json — per-machine extras, never committed
{
  "permissions": {
    "allow": [
      "WebSearch",
      "WebFetch(domain:event-driven.io)",
      "WebFetch(domain:martendb.io)"
    ]
  }
}
```

### Hooks

| Event | Script | What it does |
|---|---|---|
| `PostToolUse` (Edit/Write) | `hooks/typecheck-touched.sh` | Runs `tsc --noEmit` against `tsconfig.workspace.json` (cross-package imports resolve to `src`, so no dependency needs building first) and surfaces errors scoped to the edited file's package. An incremental cache keeps repeat runs fast. Fails the edit if TS errors are introduced — Claude sees them immediately and corrects course. |
| `Stop` | `hooks/stop-summary.sh` | Prints a short status line at turn end: branch, changed-file count, "src changed but no test changed" warning, last coverage summary. Surfaces "I forgot to run tests" without blocking. |
| `UserPromptSubmit` | `hooks/inject-context.sh` | Cheap context injection on every new prompt: branch, uncommitted-file count, unpushed-commit count. Gives Claude ambient awareness without a tool call. |

Hooks are intentionally narrow. They don't run the full test suite on every edit (too slow) — that's the human's responsibility via `/release-check` or `pnpm test`.

## `commands/` — slash commands

Trigger with `/<name>` in chat. Each is a Markdown file with frontmatter declaring `description`, `argument-hint`, and `allowed-tools`.

| Command | Purpose |
|---|---|
| `/pr` | Open a pull request with the project's canonical body shape (Closes #, Summary, Sections per concern, Test plan, Charter impact, Follow-ups). |
| `/release-check` | Run every pre-merge gate (typecheck, tests, coverage, lint, build, charter-diff) in parallel; emit a single punch-list. |
| `/charter-diff` | List every change on the branch that touches a `STABILITY.md`-covered file. Demand additive vs. breaking categorization. |
| `/coverage` | Run tests and verify 100% across statements/branches/functions/lines. Surface uncovered lines if any. |
| `/book-note` | Scaffold a book essay for a ticket in the project's narrative voice. |
| `/scaffold-package` | Walk through the contributing-new-package.md workflow, including the easily-forgotten baseline-tag step. |

## `agents/` — subagents

Specialized agents invoked via the `Agent` tool. Each is a Markdown file with frontmatter (`name`, `description`, `tools`) and a system-prompt body.

| Agent | When to invoke |
|---|---|
| `act-code-reviewer` | Before opening a PR that touches charter-covered surface. Reviews against `STABILITY.md`, naming conventions, TCK alignment, coverage, doc debt. |
| `act-test-author` | When writing tests. Knows `fixture` vs. `sandbox`, the TCK extension pattern, fault-injection patterns for adapter defensive branches, the 100% coverage gate. |
| `act-doc-writer` | When writing or revising docs/READMEs/book essays. Knows the project's narrative voice and the surface map (concepts vs. architecture vs. guides vs. book). |

## `hooks/` — hook scripts

Shell scripts referenced from `settings.json`. All return JSON on stdout (Claude reads it as structured output) and are kept short, cheap, and side-effect-free.

| Script | Hook event | Notes |
|---|---|---|
| `typecheck-touched.sh` | `PostToolUse` | Per-package incremental `tsc --noEmit`. Skips non-TS, dist, node_modules. Fails the edit when types break. |
| `stop-summary.sh` | `Stop` | Reads `coverage/coverage-summary.json` for the last test run's numbers. Prints branch + change counts. Never blocks. |
| `inject-context.sh` | `UserPromptSubmit` | Branch, uncommitted, unpushed. Cheap; runs on every prompt. |

## `skills/` — skills

Skills auto-load when their description matches the user's intent.

| Skill | When it triggers |
|---|---|
| `scaffold-act-app` | "Scaffold a new Act app", "translate this spec into code", or any request to build a new TypeScript app on the framework. |

## Editing this surface

- **Adding a slash command**: drop a new `commands/<name>.md` with the frontmatter and body. No registration step needed.
- **Adding a subagent**: drop a new `agents/<name>.md`. Invoke via `Agent` tool with `subagent_type: "<name>"`.
- **Adding a hook**: write the shell script under `hooks/`, register the entry in `settings.json` under the appropriate event. Restart the Claude session to pick up settings changes.
- **Adjusting permissions**: edit the allowlist in `settings.json`. Prefer wildcards (`Bash(pnpm:*)`) over specific commands; narrow overrides go in `settings.local.json`.

## How to use this — typical workflows

The hooks fire automatically; slash commands and subagents you invoke when they fit. Three flows worth showing end-to-end.

### Flow 1 — implementing a ticket

```
[hook: UserPromptSubmit injects branch + dirty-file context]
User: "Implement ACT-605 — Retry-After header parsing."

Claude:
1. Reads CLAUDE.md (which now points at the Rules section).
2. Creates a branch off master.
3. Writes code, tests, docs.
   ↳ Each Edit/Write triggers typecheck-touched.sh.
     If TS breaks, Claude sees the error in the next turn and fixes
     before doing more work.
4. Runs /coverage — 100% gate verified before moving on.
5. Invokes act-code-reviewer subagent for a pre-PR self-review:
     Agent({ subagent_type: "act-code-reviewer", description: "Pre-PR review of ACT-605" })
6. Runs /charter-diff — categorize touched charter files.
7. Runs /pr 605 — opens the PR with the canonical body shape and "Closes #605".

[hook: Stop summary surfaces "branch=feat/act-605, 100% coverage, ready"]
```

The hooks fill the gap between "I think it's done" and "it is done."

### Flow 2 — reviewing someone else's PR

```
User: "Review PR #738."

Claude:
1. Reads STABILITY.md (the act-code-reviewer subagent's first step).
2. Pulls the diff with `gh pr diff 738`.
3. Spawns the act-code-reviewer subagent with the diff as input:
     Agent({ subagent_type: "act-code-reviewer", description: "Review PR #738",
             prompt: "...diff content + intent paragraph..." })
4. The subagent returns a structured review (Blockers / Concerns / Nits / Verdict).
5. Claude relays the findings; doesn't paraphrase them away.
```

The point of having the reviewer as a subagent (not the main thread): it gets a clean context with only the diff and the charter rules. The main thread doesn't have to load all of STABILITY.md and the naming conventions; it just gets the verdict.

### Flow 3 — adding a new `@rotorsoft/act-*` package

```
User: "Add an act-redis adapter."

Claude:
1. Runs /scaffold-package redis — the slash command walks the
   contributing-new-package.md checklist out loud.
2. Pushes the baseline `@rotorsoft/act-redis-v0.0.0` tag against
   master BEFORE creating any files — this is the easily-forgotten
   step that prevents semantic-release from cutting 1.0.0 on the
   first release.
3. Creates the package, wires the repo files (ci-cd matrix, sidebars,
   typedoc, paths).
4. Implements the adapter against the Store TCK from libs/act-tck.
5. Invokes act-test-author for adapter tests including fault-injection
   for defensive branches:
     Agent({ subagent_type: "act-test-author", ... })
6. /coverage to confirm 100%.
7. /pr to open with the standard body.
```

## When to use what

| Situation | Tool |
|---|---|
| Wrote code; want to ship | `/release-check` |
| Wrote a test; want to confirm 100% coverage | `/coverage` |
| Touched anything in `libs/act/src/{builders,types,act.ts,ports.ts}` | `/charter-diff` before commit |
| About to open a PR | `/pr [issue#]` |
| Pre-PR self-review on charter-covered work | `act-code-reviewer` subagent |
| Adding tests with TCK / fault-injection patterns | `act-test-author` subagent |
| Writing a guide or book essay | `act-doc-writer` subagent |
| Starting a book essay for a ticket | `/book-note act-XXX <slug>` |
| Adding a new `@rotorsoft/act-*` package | `/scaffold-package <name>` |
| Building a brand-new app on the framework | `scaffold-act-app` skill (auto-triggers) |

## What the hooks tell Claude (without you asking)

The three hooks add ambient awareness no tool call would provide:

- **On every prompt** — current branch, uncommitted-file count, unpushed commits. Lets Claude infer "we're mid-PR" vs. "fresh on master."
- **After every Edit/Write** — incremental workspace typecheck (resolves deps to `src`, no build needed), errors scoped to the edited package. TS errors fail the edit; Claude sees them immediately.
- **On turn end** — change-counts and coverage summary. Surfaces "src changed, no test changed" as a one-liner so Claude doesn't claim "done" prematurely.

You don't need to remember to run these. They're free.

## Tuning the config

If a hook is too noisy in your workflow:

- **Disable a hook per-machine**: copy the `hooks` block from `settings.json` into `settings.local.json` with the offending entry removed.
- **Disable hooks entirely**: pass `--hooks-disable` when launching Claude Code, or use `/hooks` in-session.
- **Tighten or loosen permissions**: prefer adding wildcard entries (`Bash(<command>:*)`) to `settings.json` (committed, shared) over specific commands. Personal allowlist drift goes in `settings.local.json` (gitignored).

If a slash command body needs adjustment, edit the `.md` file directly — Claude reads it fresh on every invocation.

## Related project docs

- `CLAUDE.md` — the index Claude reads on session start. Rules I always follow + load-bearing one-liners.
- `STABILITY.md` — what's in the public API contract.
- `docs/docs/guides/contributing-new-package.md` — process for adding a new `@rotorsoft/act-*` package.
