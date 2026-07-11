# RFC 1238: validateFoldedState — opt-in state-schema validation after each reduction

- **Status:** accepted
- **Issue:** #1238
- **Author:** Roger Torres
- **Created:** 2026-07-11

## Motivation

Act validates two of the three shapes a reducer touches. Action inputs are
parsed against their `.on({...})` schema before a handler runs; emitted events
are parsed against their `.emits({...})` schema before they commit. The third
shape — the **folded state** a reducer produces — is trusted-total. A reducer
is assumed to always return a value that satisfies the state's declared
`state({ Name: schema })` schema, and the framework never checks.

That trust is misplaced. The calculator's divide-by-zero (#1230) is the
canonical case: a reducer computes `left / right`, `right` is `0`, and the
reducer folds `result: NaN` into a state whose schema is
`z.object({ result: z.number() })`. `z.number()` rejects `NaN`, but nothing
parses the state, so the bad value propagates. It surfaces hops later — when a
downstream reaction, a projection flush, or a `load()` for an API response
finally trips over it — as a confusing `ValidationError` pointing at the
symptom, not the reducer that produced it.

Operators hit this while developing and testing new reducers. They work around
it today by hand-writing schema parses inside reducers, or by reading the
downstream stack trace backward to guess which reduction produced the bad
value. There is no framework knob that says "check my reduced state against the
schema I already declared."

## Public surface added

- **Public type field** — `ActOptions.validateFoldedState?: boolean`, default
  `false`. When `true`, after each event is folded into state — on the command
  path (`do`), on `load`/cold-replay, and inside `projection(...).of(state)`
  state-fold — the merged full state is parsed against the owning state's
  declared Zod schema. A reducer that produces schema-violating state throws a
  `ValidationError` (existing exported error type) whose `target` names the
  state and the triggering event (`"<state>.<event>#<id>"`). When `false` the
  fold path is a bare merge with zero added cost.

No new exports, builder methods, port methods, or lifecycle events. The thrown
`ValidationError` is the already-exported type; on the projection path it rides
the existing `blocked` lifecycle event's `error` string like any other batch
handler throw.

## Alternatives considered

**Do nothing.** Leave reducers trusted-total and keep reading downstream stack
traces. Rejected: the failure mode is real (#1230), recurring, and cheap to
guard given the schema is already declared.

**A per-state flag (`state(...).validates()`).** Scope the check to individual
states. Rejected as premature: the debugging need is "turn this on everywhere
while I hunt a bug," not "permanently validate state X." An app-wide flag is
one knob to flip in a dev/CI config; a per-state flag is N declarations to add
and later remember to remove. If a per-state need ever emerges it can layer on
top without conflicting with the app-wide flag.

**Validate once on `load`, not per reduction.** Parse only the final folded
state when `load()` returns. Rejected: it loses the "at the source" property.
A stream folds many events; validating only the end state points at the last
event even when an earlier reduction produced the bad value. Per-reduction
validation names the exact triggering event.

**An environment variable (`ACT_VALIDATE_STATE`).** Rejected: `config()` is
process-global and env/package-driven, but this is a per-Act concern — a
multi-tenant process running several scoped Acts might want it on for one and
off for another. `ActOptions` is the right scope and matches how every other
per-Act knob (`correlator`, `circuitBreaker`, `listen`, `drain`) is threaded.

**Always on, accept the perf cost.** Parse folded state unconditionally.
Rejected: the fold path is the framework's hottest loop (every replayed event
on every `load`), and a Zod parse per event is not free. Making it opt-in keeps
the production hot path a bare `patch()` — when the flag is `false` the schema
is never touched, not even constructed. This is a debugging/CI aid, and it says
so in the docs.

**A runtime `if (validate_state)` inside the fold loop.** The first cut threaded
the boolean through `load`/`action`/`make_fold_handler` and branched per event.
Rejected in favor of the framework's existing decorator-selection idiom: there
are two fold functions — a bare one that is literally `patch(state, patched)`
and a validating one that patches then parses — and `build_es` selects which to
bake into the `load`/`action` closures **once at construction**, exactly the way
it already picks bare vs trace-decorated store ops from the log level. The
projection builder makes the same one-time selection for the state-fold engine.
The off-path then has no per-event branch at all, so a benchmark with the flag
off shows zero delta from pre-#1238.

## Stability / charter impact

- **Category:** public types — a new optional field on the exported
  `ActOptions` type.
- **Additive.** No rename, removal, narrowed type, or changed semantics for any
  existing surface. An app that never sets `validateFoldedState` behaves exactly
  as before. Ships as **MINOR**.
- **No port method**, so no TCK or adapter work. The validation lives entirely
  in the orchestrator's fold path (`internal/event-sourcing.ts`,
  `internal/state-fold.ts`), which the charter explicitly leaves out of scope.

## Open questions

None.
