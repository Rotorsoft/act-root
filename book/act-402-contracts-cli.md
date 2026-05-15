# ACT-402 — the `act` CLI: making implicit contracts navigable

## The pain that started it

In an Act app with twenty-plus slices, the question "who produces `OrderPlaced`? who reacts to it? which projections fold it?" turns into a grep expedition. Cross-slice contracts are *implicit*: an event is just a string key in a `.emits({...})` block on one side and a string key in a `.on()` call on the other. The compiler doesn't see the relationship. Neither do humans, unless they hold the whole graph in their head.

ACT-402 didn't try to solve the *modeling* side of that problem (the `_v<n>` convention from ACT-403 covers schema evolution, and inter-slice import contracts are out of scope). It solved the *navigation* side: give developers a way to walk the model from the terminal and have every relationship right there.

## Why not just emit a Markdown registry

The original ticket called for `pnpm act:contracts > docs/EVENTS.md` — a static dump regenerated from source. That was the natural first instinct: the diagram already parses everything, so why not pipe the same model through a Markdown templater and check the output into the repo?

Three reasons we walked away from it.

1. **Stale-doc inevitability.** Every static registry in every project I've ever worked on diverges from reality within a quarter. The Markdown either gets out of date, or someone has to remember to run `act:contracts` before each PR. Both fail.
2. **No ergonomics for the actual question.** When you're debugging "why is this reaction firing twice?", you want to type the event name and see its neighborhood. You don't want to grep Markdown.
3. **The diagram already exists for one-shot overviews.** Static dumps are a strictly worse version of what the SVG diagram gives you. The terminal needs to do something the diagram can't — and what it can do well is **focused, fast, navigable detail**.

So the new shape: an interactive explorer. Type a name, see the neighborhood. The CLI is the part of the doc surface that doesn't rot, because it's regenerated on every invocation from the live source.

## The parser was free

`@rotorsoft/act-diagram` already had `extractModel(files)` returning a `DomainModel` with every edge we needed: which actions emit which events, which slices react, which projections fold. The hard work — sucrase-transpiled module evaluation with mock builders capturing state/slice/projection/act calls — was done.

The CLI is, almost embarrassingly, a thin layer over that model:

- `loadProject(rootDir)` — walk the file system into a `FileTab[]`.
- `extractModel(files)` — already exists.
- `buildContractIndex(model)` — flatten the graph into searchable entries.
- `format*(entry)` — print a neighborhood.

Everything else is plumbing.

## What the CLI added back to the parser

One small but real addition: **best-effort Zod schema capture**.

The diagram's parser had everything except the schema text. Events showed up by name but not by shape. `mock-builders.ts` does call real `z` from the `zod` module — so the schema object exists at parse time — but the `_def` introspection across Zod 3 vs 4 vs whatever-comes-next is a moving target. Walking `_def` produces canonical output that may not match what the user wrote.

The cleaner path: re-scan the source for the literal `.emits({ ... })` block and slice out each value expression by balanced-bracket matching. This is what `schema-extract.ts` does.

It's deliberately best-effort. Two cases it handles well:

```ts
.emits({
  OrderPlaced: z.object({ id: z.string(), total: z.number() }),
  OrderShipped: OrderShippedSchema,
})
```

Both `z.object(...)` and bare-identifier references are captured verbatim. ES2015 shorthand (`{ TicketOpened }`) is recorded as the identifier name — which is exactly the right thing, because in idiomatic Act code that identifier *is* the schema:

```ts
import { TicketOpened } from "./events.js";
// ...
.emits({ TicketOpened })
```

It's also the case in `wolfdesk`, the more complex of the two example apps. The shorthand support meant `wolfdesk` events display schema references rather than `(not captured)`.

Cases it doesn't handle:

- Regex literals containing `//` inside the pattern (looks like a line comment).
- Anything past the first parser bail-out point — the function returns `null` and the caller moves on.

This is acceptable. Schema capture is decoration. The CLI's primary value is the *graph navigation*, which doesn't depend on schemas.

## The UI rebuild that wasn't planned

The first cut was a readline-based REPL. Type a name, see results, type a number to drill down. It worked and the tests were clean. Then the user typed `pnpm act` from the repo root and got:

> Loaded 14 states, 4 slices, 1 projection, 40 events.

…with no way to *see* what those 40 events were without typing 40 partial names. The summary view existed but it was dead end.

So: category navigation. Type `events`, get a list of all events. Pick by number. Same for the other kinds.

Then the user asked for arrow-key navigation, which the readline-based REPL fundamentally can't do without rebuilding the input handling from scratch. That's when we swapped in `@clack/prompts`. The interactive flow is now select → select → detail → optional editor jump, and the keyboard ergonomics come for free.

The trade-off: clack's prompts are essentially impossible to drive from a unit test. The interactive path is covered only by CI smoke tests against the example apps (a `-q` flag drops the CLI into non-interactive mode, which *is* unit-testable and is what CI exercises).

`-q` started as a coverage workaround and ended up being the most-used surface in scripts. There's a lesson there about making the test seam *be* the API.

## Editor jumps were one-line obvious in hindsight

The user's idea: when you've drilled down to a final entity, why not press enter and open `$EDITOR` at that file:line? It's the natural next step in the flow — you've found the thing you want; now you want to *go to* the thing.

The implementation is fifteen lines (`open-editor.ts`). Pick editor from `$VISUAL` → `$EDITOR` → `vi`. Detect VS Code / Cursor (they take `--goto file:line`) versus the vim family (they take `+line file`). Spawn with inherited stdio.

The reason this is worth a note: it's the kind of feature that *only* works when the model has accurate file:line information for every entity. The earlier rounds of the CLI revealed that several entity types (reactions, projections) weren't carrying file paths through the parser. Threading those through `ReactionNode.file` and `ProjectionNode.file` was the prerequisite. Without it, the "open in editor" flow would have been broken for half the entities.

The Markdown-registry shape would never have surfaced that gap, because Markdown doesn't care about file:line.

## What I'd do differently

- I burned time chasing 100% branch coverage on default-arg ternaries that v8's coverage tool counts as branches but that have no semantic content. Should have called the project thresholds (90/95/95/95) sufficient earlier.
- The `INIT_CWD` plumbing for `pnpm -F` invocation is fragile. pnpm doesn't set `INIT_CWD` the way npm does. The pragmatic fix was to make the root `act` script call `tsx` directly. If we ship a "real" bin (post-build), this gets simpler — the bin runs from wherever the user invokes it.
- I added test directories aggressively to the skip list (`test`, `tests`, `__tests__`, `e2e`, `bench`, `benches`, `benchmark`, `benchmarks`, `perf`, `scripts`). Some Act apps may legitimately keep source under `test/` for unusual reasons. The skip is a heuristic, not a contract. If it bites, a `--include <dir>` flag is the natural escape hatch.

## What this teaches about Act's doc surface

The Act ecosystem has three doc surfaces at three different time scales:

| Surface | Time scale | What it shows |
|---|---|---|
| Docusaurus + READMEs | Hours-to-weeks | Concepts, contracts, "how to" |
| `act-diagram` (SVG) | Live | Structural overview as a picture |
| `act-inspector` | Runtime | Live state, drains, leases, projections |
| `act` CLI | Live | Structural overview as searchable text + editor jumps |

ACT-402 plugged the gap that grep was filling. The fact that the parser was already there meant the cost was low. The fact that the parser drives multiple surfaces means improvements compound: every fix to schema capture benefits both the CLI and the diagram tooltips.

The book chapter this becomes, eventually, is the one on **doc surfaces in event-sourced systems** — why static Markdown drifts, why "one diagram to rule them all" misses the focused-detail case, why the right answer is multiple thin surfaces over a single shared parser.
