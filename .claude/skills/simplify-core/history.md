# Simplify-core history

One entry per run, newest last. Record the metrics, the lenses run, the proposals, and the user's decisions so nothing rejected is proposed again without a material change.

## 2026-10-07 — baseline

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

Largest files:
- libs/act/src/act.ts (2369)
- libs/act/src/types/ports.ts (1476)
- libs/act/src/adapters/in-memory-store.ts (1434)
- libs/act/src/types/action.ts (1228)
- libs/act/src/internal/correlate-cycle.ts (961)
- libs/act/src/builders/state-builder.ts (919)
- libs/act/src/internal/event-sourcing.ts (899)

Lenses: none (baseline). Context: the framework is published, and many recent changes were bug fixes that each added mechanism; the user notes some overcomplicated things. Notable: 52% of core lines are comments, 404 ticket references in source, 21 files over 300 lines, IAct declares 8 methods while the Act class exposes 20.
