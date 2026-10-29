# RFC 2182: business rules are preconditions; invariants are the state schema

- **Issue:** #2182 (with #2179); removal in 2.0: #2183
- **Author:** Claude (with Rotorsoft)
- **Created:** 2026-10-27

## Motivation

In design by contract (Meyer, Eiffel), the two words mean different things:

- **A precondition** must be true for one operation to run now, and can be false at other times. "The ticket is open" holds until someone closes it.
- **An invariant** must be true of the object after every operation, whoever calls it. "A closed ticket has a closer" is never false in a valid ticket.

Act called its `.given` rules invariants (`Invariant`, `InvariantError`), but every one in this repo is a precondition: it guards one action and is false at some point in a normal lifecycle (a closed ticket, the wrong phase, not your turn). The test is "if the rule is false, is the state broken?" For `mustBeOpen` it isn't, because a closed ticket is valid.

The real invariants of a domain already have a home: the state's Zod schema, refinements included. #2179 folds an action's events before the commit, so checking that schema there refuses a broken state before it is stored. Until now that check hid behind an opt-in flag, `validateFoldedState`, so most apps never checked their invariants at all.

This RFC makes `.requires` the one place for business rules, makes the schema check always on, and deprecates the misnamed surface in a minor, to be removed in 2.0.

## Public surface added

- **`PreconditionError`** (class, `@rotorsoft/act`): what `.requires` throws, with the message `"<action> failed precondition: <description>"` and the same fields as `InvariantError` (`action`, `payload`, `target`, `snapshot`, `description`). It extends `InvariantError` until 2.0, so a `catch` on `InvariantError` still catches every refused action.
- **`Errors.PreconditionError`**: `"ERR_PRECONDITION"`, the new error's `name`.
- **act-http `ERROR_MAP.PreconditionError`**: `{ status: 409, code: "PRECONDITION" }`, wire name `"PreconditionError"`.
- **act-diagram `ActionNode.preconditions`** (already optional) now lists every precondition in the order they run, the deprecated `.given` rules first.

## Public surface deprecated (removed in 2.0, #2183)

All keep working unchanged until then:

- `.given([...])` on the action builder and the `Invariant` type. Write the rule as a `Precondition` that ignores the payload (`Precondition<S, unknown>`, `holds: (_, state, actor) => ...`) in `.requires([...])`.
- `InvariantError` and `Errors.InvariantError` (`"ERR_INVARIANT"`). `.given` rules keep throwing it, with the message `"failed invariant"`.
- `ActOptions.validateFoldedState`. It is ignored: the check is always on.
- act-http `ERROR_MAP.InvariantError` (409 `INVARIANT`), still mapped for `.given` refusals.
- act-diagram `ActionNode.invariants`, still filled with the `.given` descriptions.

## Behavior change

Every action checks the state it leaves against the state's schema once, before the commit. A state the schema rejects refuses the action with `ValidationError` (target `"<state>.<action>"`), and nothing is stored. The check reads the state without replacing it. Loads, replays and projection folds don't check, so a stream that already holds a bad event still loads.

## Alternatives considered

- **Remove the old names in this release.** Cleaner, but breaks every app that uses `.given` or catches `InvariantError` in a minor. Deprecating first follows the charter's deprecation policy.
- **A `StatePrecondition` type for `.given`.** One more name for what `Precondition<S, unknown>` already says, and it would keep two builder methods for one concept.
- **Keep the check opt-in, renamed `validateInvariants`.** A correctness check that most apps never turn on protects nothing, and the name still reads as optional.
- **Check after every event, and on loads.** An invariant holds between actions, not between one action's events, so a per-event check can refuse a valid action. Checking loads makes any stream with an old bad event unloadable after an upgrade, and costs a parse on every replay.
- **A new `.invariants([...])` state builder.** It would duplicate what Zod refinements already express, and it adds surface.

## Stability / charter impact

- Categories: public types and errors (`@rotorsoft/act`), the `ActOptions` bag, act-http's wire contract, and act-diagram's model type.
- **Additive, plus deprecations.** No surface is removed. Two behaviors change and go in the release notes:
  - An app whose reducers produce a state its schema rejects now has that action refused. Before, that state was stored unless `validateFoldedState` was on.
  - A `.requires` refusal now has the name `ERR_PRECONDITION` (it was `ERR_INVARIANT`), and act-http answers it with code `PRECONDITION` (it was `INVARIANT`). `instanceof InvariantError` still matches.

## Open questions

None.
