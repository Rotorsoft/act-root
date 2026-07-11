# ACT-1238 — The one shape the framework refused to check

## The pain that started it

Act had always been fastidious about validation, or so it seemed. Every action payload gets parsed against the schema declared in its `.on({...})` before a handler runs. Every event a handler emits gets parsed against its `.emits({...})` before it commits. Two of the three shapes a reducer touches are checked at the door. The third one, the state the reducer actually produces, was waved through on trust. A reducer was assumed to be total, to always return something that satisfies the state schema the developer wrote, and the framework never once looked to confirm it.

The calculator found the hole, as toy examples so often do. A divide handler computed left over right, right happened to be zero, and the reducer folded a result of NaN into a state whose schema said the result was a plain number. Zod rejects NaN for `z.number()`, but nothing parsed the state, so the bad value simply became the truth. It rode along quietly until some later moment, a projection flush, a downstream reaction, a load for an API response, tripped over it and threw a ValidationError pointing at the symptom. The developer got a stack trace at the place the poison was consumed and no help at all finding the place it was brewed.

## Why the obvious answers didn't fit

The first instinct was to always validate. If parsing action inputs and emitted events is worth doing unconditionally, why not the reduced state too. The answer is that the fold path is the hottest loop in the framework. Every event on every load, every replay, every projection catch-up runs through it, and a Zod parse per event is not free the way a plain object merge is. Turning it on for everyone would tax every production read to catch a class of bug that only bites while a reducer is young. The check earns its keep in development and in CI, not in the steady state of a running system.

The second instinct was to scope the flag to a single state, something like `state(...).validates()`. That reads tidy on paper and misreads the actual need. Nobody wants to permanently validate exactly state X. They want to flip one switch while they hunt a bug, watch the whole application enforce its declared schemas, and flip it back. A per-state declaration is N edits to add and N edits to remember to remove, which is exactly the friction that keeps a debugging aid from being reached for. An application-wide boolean in `ActOptions` is one line in a dev config, and it sits next to `correlator`, `circuitBreaker`, `listen`, and every other per-Act knob that already lives there.

An environment variable was considered and set aside for a smaller reason. Act's `config()` is process-global and driven by package.json and the environment, but a single process can run several scoped Acts, and one tenant might want the check while another does not. The natural scope is the Act, and the natural home is the options bag it already accepts.

The last temptation was to validate only once, when a load returns, rather than after each reduction. That saves parses but forfeits the entire point. A stream folds many events, and checking only the final state names the last event even when an earlier reduction was the guilty one. Validating each reduction is what lets the error name the exact triggering event, which is the difference between a message that solves the bug and one that merely confirms it exists.

## The decision

`validateFoldedState` is a boolean on `ActOptions`, off by default. When it is off, the fold path is the same bare merge it always was, and the schema is never even constructed, so the production hot path is byte-for-byte what it was before. When it is on, one small helper wraps the merge at all three reduction sites, the command path in `action`, the replay path in `load`, and the state-fold projection engine, and parses the merged full state against the owning state's declared schema. A bad reduction throws a ValidationError whose target names the state and the triggering event as `state.event#id`, so the developer sees the reducer that produced the poison rather than the consumer that choked on it.

Threading it was almost anticlimactic once the shape was right. The flag rides into `build_es` the same way the correlator does, baked once into the bound `load` and `action` closures so every internal caller, close-cycle included, inherits it without carrying a boolean through its own signature. The projection engine is the one path that loads directly rather than through the orchestrator's ops, so it takes the flag as a defaulted parameter that the builder fills from the same options. One flag, three sites, one helper, and the thousand existing tests passed unchanged because the default changes nothing.

## What this teaches

A framework's trust boundaries are worth auditing for asymmetry. Act validated inputs and outputs and quietly trusted the transformation in between, which is a natural place for trust to pool because the transformation is the user's own code and feels like their responsibility rather than the framework's. But the user already told the framework what the result should look like, in the state schema, and declining to check that promise was leaving a declared contract unenforced. The fix was not a new capability so much as honoring information that was already on the table. The reason it ships as an opt-in rather than an always-on guard is the other half of the lesson, that the right altitude for a check is not always the same as the right frequency, and a debugging aid earns its correctness by staying out of the path it is not needed on.

## Connections to other chapters

The behavior-contracts ledger that now pins this claim to its tests is ACT-1029's legacy, the same discipline that caught the watermark granularity bug in ACT-1179. The instinct to prefer an orchestrator-side flag over a new port method or a per-state declaration is the same restraint that shaped the sensitive-data and close-policy work, where the cheapest surface that solves the problem beats the more general one that invites relitigation later.
