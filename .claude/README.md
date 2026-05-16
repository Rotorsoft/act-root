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

A consolidated allowlist that covers the 95% case: `pnpm:*`, `git:*`, `gh:*`, common file utilities, `WebFetch` for project/npm/docs domains, `WebSearch`. Anything narrower can go in `settings.local.json` for the individual contributor.

### Hooks

| Event | Script | What it does |
|---|---|---|
| `PostToolUse` (Edit/Write) | `hooks/typecheck-touched.sh` | Runs `tsc --noEmit` on the package that owns the edited file. Fails the edit if TS errors are introduced — Claude sees the errors immediately and corrects course before the next operation. |
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

## Related project docs

- `CLAUDE.md` — the index Claude reads on session start. Rules I always follow + load-bearing one-liners.
- `STABILITY.md` — what's in the public API contract.
- `docs/docs/guides/contributing-new-package.md` — process for adding a new `@rotorsoft/act-*` package.
