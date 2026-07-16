---
name: debug_wave
description: Runs an adversarial bug-hunting "wave" over the Act framework and its adapters — fans out several parallel hunter agents across distinct lenses, each proving findings red-first with a control, then independently re-verifies survivors and files them as tickets. Use when the user says "run a wave", "run another wave", "resume the hunters", "hunt for bugs", "debug wave", or asks to sweep the codebase for latent defects.
---

# Debug Wave

A wave is a fan-out of independent **hunter** agents, each scanning one *lens* of the codebase for a real, previously-unknown defect, followed by a **main-loop verification-and-triage pass** that reproduces every survivor and files it as a ticket. The whole point is to find bugs the test suite is green over — divergences and contract violations that ship because no test exercises the exact composition that exposes them.

**Reference:** [invariants.md](invariants.md) — the standing domain facts a hunter must not violate, the log of past confirmed bugs and false positives. Read it before every wave and append to it after.

The wave earns its cost by being adversarial and disciplined, not by being large. A finding is worthless unless it survives two gates: a **red test with a control**, and the **domain model**. Most of this skill is those two gates.

## When to run one

The user drives cadence. They will say "run a wave" or "run another wave" — that is the trigger. A wave is expensive (several agents, each burning real tokens over minutes), so never start one unprompted. Between waves the user reviews findings, merges fixes, and decides when to sweep again.

## The shape of a wave

1. **Sync and scope.** Make sure the working tree is on an up-to-date `master` (or the branch under test) and clean. Pick the lenses (below) — favor dimensions not swept in recent waves; check [invariants.md](invariants.md) for what prior waves already ruled out.
2. **Fan out hunters.** Launch several general-purpose `Agent`s in parallel (one message, multiple tool calls), one per lens. Each gets the hunter contract below, specialized to its lens. Three to five is the usual size; scale to what the user asked for ("quick pass" → 2-3, "thorough" / "another wave" → 4-5).
3. **Collect as they finish.** Hunters run in the background and notify on completion. Don't block the user — relay each result as it lands.
4. **Verify survivors yourself.** For every CONFIRMED finding, **independently reproduce it in the main loop** before you believe it. Hunters are fallible and their red claims are not evidence on their own (see the #1254 lesson in [invariants.md](invariants.md)). Reproduce the higher-severity ones at minimum; trust a hunter's low-severity finding only when its control is a clean cross-adapter A/B.
5. **Sweep and triage.** Delete any probe files hunters left behind (they sometimes write into `libs/*/test` against instructions). Confirm the tree is clean. Consolidate into a severity-ranked report.
6. **File, don't fix.** File each confirmed bug as a ticket (structure below). Do **not** start fixing without the user's go-ahead — propose a fix order and let them direct. Filing is the deliverable of a wave; fixing is a separate, approved step.

## Lens catalog

Each hunter owns one lens so their searches don't overlap. Lenses that have paid off:

- **Store adapter divergence** — where InMemory, PostgresStore, and SqliteStore disagree on a `Store` method the store-TCK doesn't fully exercise. Focus on the least-covered methods: `query_stats`, `query_streams` (+ anchor contract), `truncate`/windowed close, `block`/`unblock`, `defer`, `prioritize`, lease finalize, and secondary `query` params in combination. The control is trivial: run the same sequence against two adapters and assert they agree.
- **Cache / snapshot / `with_snaps` resume + untested behavior-contract claims** — the `with_snaps` resume floor, snapshot boundaries, time-travel (`asOf`). Cross-check `docs/docs/architecture/behavior-contracts.md`: for each documented runtime guarantee, does a test actually fail if it stops holding? A claim with no guard is a prime hunting ground. (This lens found the #1261 time-travel bug.)
- **Orchestrator correctness** — correlate/drain/settle/close-cycle: priority+lane merges, backoff, blocked-stream recovery, retry accounting, watermark math. High-value but the highest false-positive risk — this is where #1254 died and #1255/#1262 were real. Demand extra rigor here.
- **Close-cycle / fairness / concurrency** — windowed-close prune boundaries, the fairness reserve slice math, competing-consumer SKIP LOCKED. Hand-enumerate the math before suspecting the code.

These aren't exhaustive. When the obvious lenses are swept out, invent new ones (error-path fault injection, config-validation edges, versioned-event deprecation, cross-package contract seams like act-ops / act-http receivers). A lens is good when one search angle is blind to what the others would find.

## The hunter contract (put this in every hunter prompt)

Specialize the lens, but every hunter carries the same discipline:

**Proof-first (mandatory).** No finding ships on reasoning alone. Write a throwaway spec that is RED on the suspected bug and GREEN on a control — another adapter, or the documented contract. Run it. A hypothesis you can't turn red is not a finding.

**Survive the domain model (mandatory).** Before declaring a bug, rule out "correct by design." Read [invariants.md](invariants.md) and the relevant `docs/docs/architecture/*.md` and the method's doc-comment to confirm which behavior is the *contract*. A red test that contradicts a load-bearing invariant is a bug in the test, not the code — that is the #1254 lesson. After writing the red test, **run the existing suite for that subsystem** and confirm the implied fix wouldn't break it. A proven-red behavior is not a bug until the fix survives the full suite and the invariants.

**Mechanics.**
- Postgres runs on port **5431** (`docker ps` → `act-pg`); copy the connection helper from an existing `libs/act-pg/test/*.spec.ts`.
- Vitest only discovers specs **inside the project tree** — a probe under `/tmp` or the scratchpad is silently ignored (`No test files found`). Write probes into the package's `test/` dir with a clearly disposable name (e.g. `_probe_<lens>.spec.ts`), run, then **delete**.
- Use `fixture(builder)` / `sandbox(builder)` from `@rotorsoft/act/test` for orchestrator probes; prefer explicit `await app.correlate(); await app.drain();` over `settle()` for deterministic cycle counts.
- Do **not** edit anything under `libs/*/src` or `libs/*/test` (the real files). Only throwaway probes, which you delete. Leave the tree clean.

**Report format (the hunter's final message).** For each CONFIRMED bug: a one-line title, `file:line` of the root cause, the failure scenario (inputs → wrong output vs the control's correct output), the red-test verdict (which side failed, the assertion diff), a one-line fix direction, and — for orchestrator findings — an explicit sentence on how it survives the monotonic-id / convergence model. Rank by severity. If nothing survives, say **"NO CONFIRMED BUGS"** and list the candidates ruled out and why. Ruling everything out is a good outcome — never manufacture a bug to have something to report.

## The main-loop verification pass

When a hunter reports a confirmed bug, **do not relay it as fact until you've reproduced it yourself.** Write your own minimal red test in-tree, run it, delete it. Read the trigger path to confirm reachability (e.g. for #1261, that `event-sourcing.ts` actually passes `with_snaps: true` alongside the time bound). Only findings you personally turned red go into tickets as "reproduced."

Then sweep: `git status --short` should be clean; remove any `_probe`/`hunt`-named files or temp dirs the hunters left. Confirm the scratchpad note of stray files matches what you delete.

## Ticket structure (the wave's deliverable)

File each confirmed bug with `gh issue create`, assigned to `rotorsoft`, labeled `bug` + a `priority:*` + an `area:*`, mirroring #1257/#1258/#1261-#1263. Body sections, in order:

- **Defect** — the root cause with `file:line` for every adapter/site affected.
- **Failure scenario** — concrete inputs → wrong output vs. correct output.
- **Proof (red)** — the assertion that fails, and a note that it was reproduced independently.
- **Contract violated** (when applicable) — the doc/behavior-contracts row it breaks.
- **Fix direction** — the minimal fix. When the fix is a genuine design decision (like #1262's persist-vs-surgical-vs-lease options), lay out the alternatives with trade-offs rather than presupposing one — that respects the "propose, don't over-engineer" rule.

Severity grading: silently returns wrong data → **high**; conditional or recoverable degradation → **medium**; dev/test-only or reachable only via unusual direct calls → **low**.

## Closing a wave

After filing, append to [invariants.md](invariants.md): any new confirmed bug (as a pattern for future waves to check regressions against) and any new "correct by design" fact a hunter should not re-flag. This is how the wave compounds — each one makes the next one sharper. Then report the consolidated table to the user and recommend a fix order; stop there until they choose.
