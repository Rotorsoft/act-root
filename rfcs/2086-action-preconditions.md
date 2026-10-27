# RFC 2086: named preconditions with `.requires(...)`

- **Status:** accepted
- **Issue:** #2086
- **Author:** Claude, for rotorsoft
- **Created:** 2026-10-24

## Motivation

An action is checked in three layers before it commits: the Zod schema on its payload, the invariants in `.given([...])`, and whatever its `.emit(...)` handler throws. The first two are named and visible: the `act` CLI lists invariants, the diagram counts them, and the flow player checks them one by one (#2085). The third layer is a plain `throw` buried in the handler. No tool can see it: it has no name, no listing, no place in the animation. Each app also throws its own error type.

That third layer is most of the rulebook. Risk's `Attack` has two invariants and seven throws in its handler, and `BlitzAttack` repeats all seven word for word:

```ts
.on({ Attack })
.given([mustBeInAttack, mustBeCurrentPlayer])
.emit((data, { state }, { actor }) => {
  if (state.pendingConquest.maxExtra > 0) throw new Error("Must complete conquest movement first");
  const hand = state.cards[actor.id] ?? [];
  if (hand.length >= 5 && findValidTradeSet(hand)) throw new Error("Must trade cards first (5+ cards in hand)");
  const from = state.territories[data.from];
  const to = state.territories[data.to];
  if (!from || !to) throw new Error("Invalid territory");
  if (from.owner !== actor.id) throw new Error("You don't own the attacking territory");
  if (to.owner === actor.id) throw new Error("Cannot attack your own territory");
  if (!isAdjacent(data.from, data.to)) throw new Error("Territories are not adjacent");
  if (from.armies <= data.attackDice) throw new Error("Not enough armies to attack (must leave at least 1)");
  // ... roll dice, compute the outcome, emit Attacked
})
```

Apps already want this layer named. Wolfdesk's `AcknowledgeMessage` constructs an `InvariantError` by hand for a rule that needs the payload ("Must be receiver to ack"), because `.given()` can't see the payload.

### Why invariants stay as they are

The book (*Event Sourcing in Practice with TypeScript*, ch. 3 "Three Layers of Defense" and "Throwing from Emit") makes the case from Meyer's *Design by Contract*:

- **An invariant** is a state-only rule that holds at every stable point ("the game is in the attack phase"). It never sees the payload, so one invariant serves every action that needs it, and it can be tested alone.
- **A precondition** is specific to one operation and its arguments ("you own *this* territory"). Passing the payload to invariants would tie each invariant to particular actions and lose the reuse.

So the goal is not to merge the two concepts. It's to give preconditions the same visibility invariants have, while keeping them separate.

## Public surface added

- **Builder method:** `.requires(rules)` on the action chain of `state(...)`, between `.given(...)` and `.emit(...)`:
  ```ts
  .on({ Attack })
  .given([mustBeInAttack, mustBeCurrentPlayer])
  .requires([territoriesExist, ownsFrom, targetsAnEnemy, adjacent, enoughArmies])
  .emit((data, { state }, { actor }) => { /* dice and outcome only */ })
  ```
  `.on(...)` returns `{ given, requires, emit }`, `.given(...)` returns `{ requires, emit }`, and `.requires(...)` returns `{ emit }`. Invariants always come first: they're cheaper (state only), and they're the layer the book teaches first.
- **Public type:** `Precondition<TState, TPayload, TActor>`:
  ```ts
  type Precondition<TState extends Schema, TPayload, TActor extends Actor = Actor> = {
    description: string;
    holds: (payload: Readonly<TPayload>, state: Readonly<TState>, actor?: TActor) => boolean;
  };
  ```
  Payload comes first, as it does in the `.emit` handler. The predicate is `holds`, not `valid`: "valid" and "validate" belong to the schema layer (`ValidationError`, the `validated` payload), and a failed precondition must not read like a schema failure. `Invariant.valid` is published and stays, so the two layers name their predicate differently. That's the price of keeping the words apart. `requires` types each rule against the action's own payload, so a precondition declared over a narrower shape (`{ from: string }`) fits every action whose payload has that field: `Attack`, `BlitzAttack` and `Fortify` can share `ownsFrom`.
- **No new error class.** A failed precondition throws the existing `InvariantError` with the rule's `description`, and the message `"<action> failed precondition: <description>"` (an invariant's reads `failed invariant:`). act-http already maps `InvariantError` to 409. The next section explains why one error is right for both layers.

### Vocabulary

One term per thing, the same in the builder, the types, the internals, the tools and the docs:

| Where | Name |
|---|---|
| builder clause | `.requires([...])` |
| each item | `Precondition` |
| its predicate | `holds(payload, state, actor)` |
| registry field | `requires[action]`, beside `given[action]` |
| failure | `InvariantError` (published name, kept), message "failed precondition" |
| parser, CLI, diagram, flow spec | `preconditions` |
| never used for this layer | `valid`, `validate`, `validation` (the schema layer), `check`, `guard` |

This follows the pattern `.given` already set: the clause is `given`, its items are `Invariant`s. In Eiffel, the `require` clause holds the preconditions.

### Design by Contract: one error for both layers

Meyer gives each assertion kind a party to blame, and Eiffel raises a distinct exception for each. A violated **precondition** (`require`) is the caller's fault: it asked for something it wasn't entitled to. A violated **postcondition** (`ensure`) or **class invariant** is the supplier's fault: the routine broke its own promise.

Act's `.given` rules are not class invariants in that sense. "The game is in the attack phase" isn't meant to hold at every stable point; it's a condition for calling `Attack` now, and failing it refuses the command and tells the caller why. In Meyer's terms it's a precondition on the state. So `.given` and `.requires` are both preconditions, one reading state and actor, the other the payload too. Both blame the caller, and both mean "refused" (409). One error type for both matches that. The class name `InvariantError` is the historical misfit, and it stays because it's published. The message and the `description` say which layer refused.
- **No port, lifecycle event or option changes.**

### Order and short-circuit

The checks run in this order: schema, then invariants in declaration order, then preconditions in declaration order, then the handler. The first failure stops the action and nothing commits. The flow player's checklist (#2085) lists invariants, then preconditions, in that order, and stops at the same rule. A throw from the handler stays the last row, as it is today.

### Tooling

- The `act-diagram` parser reads `.requires([...])` the same way it reads `.given([...])` (`build-model.ts` maps `st.given[action]`), and records `preconditions: string[]` per action.
- The `act` CLI lists preconditions under invariants. The diagram's ◆ count includes both.
- The `animate-act-flows` skill writes `preconditions` into each action node, and the player checks them after the invariants.

## Before and after

### Risk: `Attack` and `BlitzAttack`

Two of the seven throws read only the state and the actor, so they're invariants in disguise. They move to `.given()`. The other five need the payload and become preconditions, shared by both actions:

```ts
// preconditions.ts
type FromTo = { from: string; to: string };
export const territoriesExist: Precondition<GameState, FromTo> = {
  description: "Both territories must exist",
  holds: ({ from, to }, state) => !!state.territories[from] && !!state.territories[to],
};
export const ownsFrom: Precondition<GameState, { from: string }> = {
  description: "You must own the attacking territory",
  holds: ({ from }, state, actor) => state.territories[from]?.owner === actor?.id,
};
export const targetsAnEnemy: Precondition<GameState, { to: string }> = {
  description: "You can't attack your own territory",
  holds: ({ to }, state, actor) => state.territories[to]?.owner !== actor?.id,
};
export const adjacent: Precondition<GameState, FromTo> = {
  description: "The territories must be adjacent",
  holds: ({ from, to }) => isAdjacent(from, to),
};
export const enoughArmies: Precondition<GameState, { from: string; attackDice: number }> = {
  description: "Leave at least one army behind",
  holds: ({ from, attackDice }, state) => (state.territories[from]?.armies ?? 0) > attackDice,
};

// game.ts
.on({ Attack })
.given([mustBeInAttack, mustBeCurrentPlayer, conquestMoveDone, cardsTradedFirst])
.requires([territoriesExist, ownsFrom, targetsAnEnemy, adjacent, enoughArmies])
.emit((data, { state }, { actor }) => {
  const from = state.territories[data.from]!;
  const to = state.territories[data.to]!;
  // ... roll dice, compute the outcome, emit Attacked
})

.on({ BlitzAttack })
.given([mustBeInAttack, mustBeCurrentPlayer, conquestMoveDone, cardsTradedFirst])
.requires([territoriesExist, ownsFrom, targetsAnEnemy, adjacent, enoughArmies])
.emit(/* ... */)
```

The handler loses about a dozen lines of checks and keeps only the game logic. The CLI, the diagram and the animation now show all nine rules. The fourteen copies of seven checks across the two handlers become seven shared declarations: five preconditions and two invariants.

### Wolfdesk: `AcknowledgeMessage`

Before:
```ts
.on({ AcknowledgeMessage })
.given([mustBeOpen])
.emit((data, snapshot, { stream, actor }) => {
  const msg = snapshot.state.messages[data.messageId];
  if (!msg) throw new errors.MessageNotFoundError(data.messageId);
  if (msg.to !== actor?.id)
    throw new InvariantError("AcknowledgeMessage", data, { stream, actor }, snapshot, "Must be receiver to ack");
  return ["MessageRead", data];
})
```

After:
```ts
.on({ AcknowledgeMessage })
.given([mustBeOpen])
.requires([messageExists, mustBeReceiver])
.emit("MessageRead")
```

With the rules declared, the handler collapses to the static `.emit("MessageRead")` form, which the diagram can read without running anything. One behavior change: `MessageNotFoundError` becomes an `InvariantError` (409 over act-http). The hand-built `InvariantError` for "Must be receiver to ack" stays the same type, now with the "failed precondition" message. An app that needs its own error type, for a 404 say, keeps that throw in `.emit`.

## What stays in `.emit`

Rules that don't fit a predicate stay as throws in the handler, as ch. 12 argues:
- branching rules, where which rule applies depends on the state (`TradeCards`' phase rule depends on hand size)
- rules that need a value the handler computes anyway
- rules that need an app-specific error type

The animation still shows these: as the final row, after every declared rule passed. `.requires` is for the simple predicates that make up most of the list.

One cost: a precondition and the handler may both look up the same value (`state.territories[data.from]`). The lookup is cheap, and the handler can rely on the preconditions having passed.

## Alternatives considered

1. **Widen `Invariant` to `valid(state, actor, payload)`.** It's additive, but it erodes the separation the book argues for: invariants start depending on one action's payload and lose their reuse. It also blurs the "invariants see state only" lesson in ch. 3 and appendix A. Rejected.
2. **Name the throw inside `.emit`:** a `PreconditionError("...")` class or a `reject("...")` helper that the parser finds statically. This is the smallest change, but the parser only sees literal messages, there's no declaration order to animate unless the parser walks the handler, and a rule can't be tested alone or shared between actions. Rejected as the main mechanism. Throws in `.emit` stay supported for what doesn't fit a predicate.
3. **Both, a declaration and a named throw.** Two new mechanisms for one concept. The declaration alone covers the common case, and plain throws already cover the rest. Rejected.
4. **A new `PreconditionError` class** (a sibling of `InvariantError`, or a subclass). It names the failure after its layer, but it splits one Design by Contract category (a refused command, the caller's fault) in two along Act's own line. Every caller (HTTP mapping, UI, retry logic) would then handle two types for one outcome, and the export list grows. Rejected; the message and the description carry the distinction.
5. **Keep `valid` as the predicate name**, so both layers share one shape. It's consistent with `Invariant`, but it reuses the schema layer's word for a business rule. Rejected.
6. **Do nothing.** Most rules stay invisible to every tool Act ships, and apps keep hand-building `InvariantError`.

## Field check

- **Decider pattern** (Chassaing; Emmett builds on it): `decide(command, state)` returns events or throws. All validation lives in `decide`, with no separate guard layer. The rules are made visible through Given/When/Then specifications, not declarations.
- **Axon:** a `@CommandHandler` validates the command against aggregate state in its body and throws. Cross-cutting payload validation goes through interceptors (for example, Bean Validation), not named per-command rules.
- **Wolverine with Marten:** the closest match. A handler can declare `Validate` or `Before` methods that run before `Handle` and can stop it. That's a named step between loading the aggregate and deciding, which is the shape `.requires` gives Act.

Act already declares invariants, where other frameworks don't, so `.requires` extends a pattern the framework already has rather than importing a new one.

## Stability / charter impact

All additive: one builder method on the state action chain (`.requires`), two public types (`Precondition`, and `RequiresHandlers` beside the existing `GivenHandlers`), the optional `requires` field on `State`, and an optional last constructor argument on `InvariantError` (`rule: "invariant" | "precondition"`, default `"invariant"`) that names the layer in the message. No new error class. Existing code compiles and behaves as before, so this ships as a minor release. Nothing is renamed or removed, and plain throws in `.emit` keep working. No port changes, so no TCK change. The parser, CLI, diagram and flow player gain a field. The repo's docs that teach the layers (`state-management.md`, `error-handling.md`, the scaffold skill's `domain.md`, `act-api.md` and `SKILL.md`, STABILITY.md) change with the code. The book's ch. 3, ch. 12 and appendix A live in their own repo and follow separately.

## Postconditions

Not proposed. A postcondition checks the state after the action's events are applied, before they commit: a promise the code makes, not a condition the caller must meet. Act only detects the structural part. `ActOptions.validateFoldedState` (RFC 1238) parses the folded state against its declared schema after each reduction, so a reducer that produces `NaN` fails where it happened, but on `do` that fold runs after the commit: the event is already stored, so it detects the bug and doesn't refuse the action. Domain postconditions ("armies are never negative") detect bugs, not bad requests, so they belong in tests (given/when/then and property tests), which catch them without a runtime check on every commit. If one is ever needed, it fits the same chain as `.ensures([...])`, Eiffel's word for it. It would be checked after the patch and before the commit, and throw an internal error rather than a refusal.

## Open questions

- **The name.** `requires` follows Eiffel's `require` keyword, the precondition clause in Meyer's Design by Contract that the book cites, and it reads as a sentence: "Attack, given it's the attack phase, requires that you own the territory". Other candidates are in the PR description.
- **Invariants in disguise.** Should `.given` docs and the scaffold skill tell authors to move state-and-actor-only throws (Risk's conquest and card-trade rules, wolfdesk's `TicketCannotOpenTwice`) into invariants? That holds independently of this RFC.
