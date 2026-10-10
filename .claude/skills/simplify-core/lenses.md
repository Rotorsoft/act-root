# Lenses

Each lens is one way of looking for things to remove. The retrospective retires lenses that stop paying and adds checks from recurring rejections. Keep this file under 200 lines; a new check replaces a weaker one.

## Code

**Public surface.** List every runtime export of each published package and every `Act` public method. For each: who uses it (`packages/`, docs, other libs)? Is it a second path to something else? Could it be internal, folded into another call, or an option instead of a method? Nothing public is deprecated or removed (ground rule 2); the useful findings are internal callers that should use internal code, public docs that over-explain, and new surface a PR is about to add.

**Dead code (tool).** `npx knip` (or `npx ts-prune`) across the workspace: exports nothing imports, files nothing reaches, dependencies nothing uses. Objective, cheap, run first when this lens is due. Known false positives, skip them: bench scripts cited from `PERFORMANCE.md`/`BENCH.md`, recipe examples run by `run.sh`, `libs/tsup.config.ts` (tsup finds it by searching up), the semantic-release and `fast-check` root devDependencies, `pino-pretty` (loaded by name).

**Hotspots (tool).** The ten functions with the most branching (Biome's `noExcessiveCognitiveComplexity`, or a count of `if`/`?`/`&&`/`||` per function), crossed with change frequency: `git log --since=6.months --name-only -- libs | sort | uniq -c | sort -rn`. Branchy code that keeps changing is where fix-on-fix chains live.

**File budget.** The largest files: what concepts does each hold? Propose the split (by concept, not by size) or the shrink (dead branches, duplicated helpers, comment noise).

**Comment noise.** Sample a large file and rewrite its comments: keep the *why*, cut ticket numbers, history ("before #1234 this…"), restated code and essays. The reasoning behind rejected designs belongs in the PR, and a lasting lesson in `learnings.md`. Internal and low-risk; batch by file.

**Concepts and options.** List the named mechanisms (lanes, priority, fairness reserve, correlation lease, work mark, defer, backoff, breaker, close lock, …) and every option bag (`ActOptions`, reaction, lane, drain/settle, autoclose). For each: the problem it solves, how many apps need it, options nobody sets or with one sensible value, mechanisms that overlap. Propose folds and removals.

**DRY across adapters and builders.** Logic implemented three times (InMemory/Postgres/SQLite) or twice (act-builder/slice-builder). Propose the single home: the orchestrator, the TCK, or `internal/config.ts`.

**Reading path.** Read the README quickstart, then follow `app.do` → `action` → `commit` and `app.settle` → correlate → drain as a newcomer would. Every file jump and every extra name to hold in your head is a finding.

**Newcomer test (quarterly).** Build the canonical example from scratch using only the README. Count concepts and imports. Record the count in `history.md`; it should only go down.

## Orthogonality

**Feature interactions.** The question: does each feature stand alone, and where two meet, do they meet through one shared primitive or through special cases?

1. *Inventory.* List the core features (lanes, priority, fairness, leases, correlation lease, work marks, defer, backoff and retry, blocking, the breaker, close and autoclose, archives, notify, snapshots, PII, batch projections). For each: the state it owns (fields, columns), its options, and the contract rows it serves. A feature that serves no row, or only rows another feature also serves, is a removal or fold candidate.
2. *Matrix.* For each pair, find where one reads the other: `grep` each feature's vocabulary per file and look at the files that mention five or more (`metrics.sh` counts them), the `Store` methods that carry several features in one call, and the fix commits whose subject names two features (`git log --since=4.months --format=%s -- libs/*/src | grep '^fix'`). Pairs that keep producing fixes rank first.
3. *Classify each interaction* as one of: **shared primitive** (both use the same mechanism, such as autoclose and backoff riding the defer schedule: fine); **justified** (the coupling has a reason that still holds: record it in the register in `history.md` so later runs don't re-dig it); **accidental** (one feature reads another's configuration to decide its own behavior, a guard cancels another layer's rule, or an option only means something next to another option).
4. *Propose for each accidental one* the fix that removes the coupling, in this order of preference: give the shared fact one owner (one layer decides; the other stops guarding); re-express one feature as a use of the other's primitive; move the decision to where the knowledge is (a reaction's retry policy belongs to the reaction, not to the lease of whichever drain ran it); make the combination impossible by construction (fold the narrowing into a key). A fix that changes what an app observes is a design question for the user, and says so.


**Tests by concept.** Specs named after a fix rather than a concept (`correlate-arm`, `correlate-armed`, `correlate-checkpoint`, …) merge into one spec per concept that describes behavior. Ticket numbers leave test names. Adapter suites (`libs/act-pg/test`, `libs/act-sqlite/test`, `libs/act-notify/test`) that repeat a TCK case move into the TCK or go. Flag tests that mutate private state where a public assertion would do, and flaky tests. **Guard:** no row of `behavior-contracts.md` and no coverage may be lost; cite the rows each merged spec still pins.

**Mutation evidence (monthly, CI only).** Retired: the Stryker setup was removed because its vitest runner can't run on vitest 5. Revive it only once upstream supports vitest 5, as one root config run in CI, and compare with the baselines in `history.md`. Surviving mutants are code no test pins down: either behavior that needs one assertion, or code that can go.

**Core or decorator?** For each feature in `@rotorsoft/act` (close and autoclose, archives, audit, restore and transfer, lanes, priority, the breaker), ask whether it could be a `Store` decorator, a builder add-on or a leaf package, the way `act-notify`'s `withBroker` and `act-otel`'s `instrument` are. What does every app pay for it (port methods, `Store` columns, `IAct` methods, options, TCK cases) whether or not it uses it? Moving a shipped feature out is breaking, so the output is a finding and a design question for the user, not a deprecation. PII was examined 2026-10-08 (see `learnings.md`).

## Packages

**Packages earn their place.** For each of the published `libs/`: who uses it, how often it changes, whether it could fold into a sibling, whether it is still maintained. A published package is public surface (rule 2): the finding is a package that should stop growing or a new one that shouldn't be added, not a removal.

## Infra

**Infra.** CI workflows and jobs (overlap, minutes per PR, jobs that never fail), scripts nothing calls, hooks that duplicate CI, the Renovate rule count, tsconfig/vite config sprawl, stale directories on disk. Propose removals, never new checks.

## Docs

**One source of truth.** Find behaviors described in several places (docs pages, package READMEs, recipes, `CLAUDE.md`, code comments) with differing wording. One page owns each; the rest link to it. `CLAUDE.md` should be the short index it says it is.

**Examples.** Do the examples in `packages/` and the docs show the simple path first, compile against today's API, and use the fewest concepts they can? An example that needs a paragraph of caveats means the API is too complicated. Include the code the `scaffold-act-app` skill writes into new apps and the `@example` blocks in public doc comments: no check compiles either, so they drift unseen.

## Process

**Process.** The contribution workflow (RFC gate, release-check, learnings entries, behavior-contract rows, doc audit, the hooks) is a cost on every change. For each step: what did it catch in the last quarter? A step that caught nothing is a candidate to drop or merge. Count from evidence: `gh pr list --state merged --json body` (how often a gate is declared away) and `gh run list` per workflow (failures, and on whose PRs).

## Smells

Check for these by name; the retrospective adds recurring rejection reasons here as checks.

- A mechanism that undoes another mechanism: an exemption, guard or reset whose only job is to cancel a side effect of something else.
- Run-once latches and armed flags reset from several places.
- Comments longer than the code they explain; comments citing tickets or describing what the code used to do.
- Options with one sensible value, or defaults nobody overrides.
- Two paths to the same result (two entry points, two builders, a method and an option that both do it).
- Adapter code re-implementing orchestrator logic, or the orchestrator doing a store's job.
- The same behavior documented in four places, each slightly different.
- A test file per ticket instead of per concept.
- A layer that passes calls through unchanged, kept for one decorated call. Not the trace seams (`build_es`, `build_drain`): they pick bare or traced ops once at build and stay.
- A gate most PRs have to declare away.
- A timer or background path that only sets a flag the foreground reads later (#1804 polling, the defer timer). Make it run the foreground path.
- A check that has never failed, including its self-test: plant the error and assert that exact error comes back.
- A feature that reads another feature's configuration to decide its own behavior (retry timing from the lease length, a stream's lane from its priority, a lease key from the lane set). Each is an edge in the interaction matrix; give the fact one owner.
- A rule in the store and a guard in the orchestrator that cancels it (or the reverse): two owners for one field.
