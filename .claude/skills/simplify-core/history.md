# Simplify-core history

The skill's memory. Read it first on every run; the retrospective (step 7) updates it. Newest run last.

## Lens rotation

Least recently run goes next. A lens with no accepted proposal in its last three runs is retired (it can be revived with a reason).

| lens | last run | runs | accepted | status |
|---|---|---|---|---|
| Public surface | never | 0 | 0 | active |
| Dead code (tool) | never | 0 | 0 | active |
| Hotspots (tool) | never | 0 | 0 | active |
| File budget | never | 0 | 0 | active |
| Comment noise | never | 0 | 0 | active |
| Concepts and options | never | 0 | 0 | active |
| DRY across adapters and builders | never | 0 | 0 | active |
| Reading path | never | 0 | 0 | active |
| Newcomer test (quarterly) | never | 0 | 0 | active |
| Tests by concept | never | 0 | 0 | active |
| Mutation evidence (monthly, CI) | never | 0 | 0 | active |
| Packages earn their place | never | 0 | 0 | active |
| Infra | never | 0 | 0 | active |
| One source of truth | never | 0 | 0 | active |
| Examples | never | 0 | 0 | active |
| Process | never | 0 | 0 | active |

## Next-major list

Approved breaking simplifications, each with its deprecation already shipped. They land together in one major with one migration guide.

_(empty)_

## Self-changes

Every change the retrospective made to `SKILL.md`, `lenses.md` or `metrics.sh`, with the evidence that prompted it.

_(none yet)_

## Runs

### 2026-10-07 — baseline (no lenses)

| metric | value |
|---|---|
| core lines (libs/act/src) | 21389 |
| code lines / comment lines | 10221 / 11168 (52% comments) |
| ticket refs in source | 404 |
| files over 300 lines | 21 |
| runtime exports (@rotorsoft/act) | 54 |
| IAct methods / Act class public methods | 8 / 20 |
| Store port methods | 18 |
| ActOptions fields | 14 |
| spec files / test lines (all libs: 45523 src lines) | 241 / 60936 |
| test names citing tickets | 200 |
| published packages (libs/) | 12 |
| CI workflows / lines | 8 / 1132 |
| docs lines (excl. generated API) / CLAUDE.md lines | 9552 / 333 |

Largest files:
- libs/act/src/act.ts (2369)
- libs/act/src/types/ports.ts (1476)
- libs/act/src/adapters/in-memory-store.ts (1434)
- libs/act/src/types/action.ts (1228)
- libs/act/src/internal/correlate-cycle.ts (961)
- libs/act/src/builders/state-builder.ts (919)
- libs/act/src/internal/event-sourcing.ts (899)

Context: the framework is published, and many recent changes were bug fixes that each added mechanism; the user notes some of them overcomplicated things (e.g. #1795, closed unmerged in favor of a doc fix). Notable starting points: 52% of core lines are comments; 404 ticket references in source and 200 in test names; 21 core files over 300 lines; `IAct` declares 8 methods while the `Act` class exposes 20; tests (61k lines) outweigh library source (45k); 104 core spec files, many named per ticket (seven `correlate-*` specs).

Proposals: none (baseline). Decisions pending: none.
