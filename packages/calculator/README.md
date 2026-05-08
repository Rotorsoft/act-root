# @act/calculator

A minimal Act example — a calculator state machine built around a single aggregate, plus standalone demos for projection rebuild and close-the-books.

> Workspace package, not published. Run via `pnpm dev:calculator` from the monorepo root.

## What it demonstrates

- A focused state machine with custom event reducers
- Multiple events emitted from a single action
- Invariants that gate actions (e.g. `Clear` only works on a "dirty" calculator)
- Snapshotting (`.snap((s) => s.patches > 12)`)
- Reactions across streams — digit presses on calculators `A`/`B` aggregate into a shared `Board` projection state, and operator presses fan out to per-calculator result streams
- Source-regex resolvers (`source: "^(A|B)$"`) and dynamic resolvers (`(e) => ({ source: e.stream, target: "Calculator" + e.stream })`)
- Auto-correlation: reaction handlers call `app.do(...)` without an explicit `reactingTo` — the framework injects the triggering event automatically
- A tRPC router exposing `PressKey` / `Clear` for the React client to consume

## Quickstart

```bash
# From the monorepo root
pnpm install

# Run the calculator demo loop (random key presses across two streams)
pnpm dev:calculator

# Or the standalone demos:
pnpm -F calculator dev:rebuild   # projection rebuild
pnpm -F calculator dev:close     # close-the-books
```

The default demo (`pnpm dev:calculator` → `src/main.ts`) loops random `PressKey` actions across streams `A` and `B` until any digit on the `Board` aggregate has been pressed more than 3 times, then prints the final state and full event log.

## Layout

```
packages/calculator/
├── src/
│   ├── calculator.ts      # Calculator state — events, patches, actions, invariants
│   ├── main.ts            # Demo loop with reactions to a Board + per-stream result projection
│   ├── rebuild-demo.ts    # Demonstrates app.reset() + drain for projection rebuild
│   ├── close-demo.ts      # Demonstrates app.close() — archive, tombstone, restart
│   ├── router.ts          # tRPC router exposing PressKey + Clear
│   └── index.ts           # Re-exports calculator + router
└── test/
    └── invariants.spec.ts # Invariant + validation error coverage
```

## The Calculator state

A single state with five events and two actions:

| Event             | Reducer                                                  |
|-------------------|----------------------------------------------------------|
| `DigitPressed`    | Append the digit to `left` (or `right` if there's an op) |
| `OperatorPressed` | If both operands present, compute and store result       |
| `DotPressed`      | Append `.` if not already present in current operand     |
| `EqualsPressed`   | Compute pending operation                                |
| `Cleared`         | Reset to `{ result: 0 }`                                 |

| Action     | Schema                       | Notes                                                   |
|------------|------------------------------|---------------------------------------------------------|
| `PressKey` | `{ key: digit \| op \| symbol }` | Routes to one of `DigitPressed` / `OperatorPressed` / `DotPressed` / `EqualsPressed` — can emit multiple events |
| `Clear`    | empty                         | Guarded by `Must be dirty` invariant                    |

Snapshot after every 12 patches:

```ts
.snap((s) => s.patches > 12)
```

## Reactions in `main.ts`

Two inline reactions wire the single `Calculator` aggregate into wider workflows:

```ts
const app = act()
  .withState(Calculator)
  .withState(DigitBoard)
  .withState(CalculatorResult)

  .on("DigitPressed")
  .do(async (event) => {
    await app.do("CountDigit", { stream: "Board", actor }, { digit: event.data.digit });
  })
  .to({ source: `^(${streams.join("|")})$`, target: "Board" })

  .on("OperatorPressed")
  .do(async (event) => {
    const calc = await app.load(Calculator, event.stream);
    await app.do(
      "ProjectResult",
      { stream: "Calculator" + event.stream, actor },
      { result: calc.state.result }
    );
  })
  .to((e) => ({ source: e.stream, target: "Calculator" + e.stream }))
  .build();
```

- The `DigitPressed` reaction uses a **static** target (`"Board"`) with a source regex — the framework subscribes the target stream once at boot.
- The `OperatorPressed` reaction uses a **dynamic** target — Act re-correlates on each scan to discover new `Calculator{stream}` targets.
- Neither `app.do(...)` call passes `reactingTo` explicitly — the triggering event is auto-injected so causation chains stay intact.

## tRPC router (`src/router.ts`)

Single shared `calculator` stream, used by `packages/server` and `packages/client`:

```ts
const target = { stream: "calculator", actor: { id: "1", name: "Calculator" } };

export const calculatorRouter = t.router({
  PressKey: t.procedure
    .input(Calculator.actions.PressKey)
    .mutation(({ input }) => app.do("PressKey", target, input)),
  Clear: t.procedure.mutation(() => app.do("Clear", target, {})),
});

export type CalculatorRouter = typeof calculatorRouter;
```

`Calculator.actions.PressKey` is the original Zod schema, used directly as tRPC input validation — no duplication.

## Standalone demos

### Projection rebuild — `dev:rebuild`

`src/rebuild-demo.ts` builds a `Counter` state with a `SumProjection`, emits five `Incremented` events, drains them, then resets the projection watermark and re-drains:

```ts
const resetCount = await app.reset(["sum-proj"]);
await app.drain({ eventLimit: 100 });
```

`app.reset(["sum-proj"])` resets the watermark **and** arms the orchestrator's internal `_needs_drain` flag — calling `store().reset(...)` directly would not. The demo verifies the rebuilt sum matches the live state after each rebuild.

### Close-the-books — `dev:close`

`src/close-demo.ts` shows the full close lifecycle:

1. Emit events across `counter-A`, `counter-B`, `counter-C`
2. Close `counter-A` (archived) and `counter-B` (tombstoned, no archive callback)
3. Verify writes to a tombstoned stream throw `StreamClosedError`
4. Close `counter-C` with `restart: true` — emits a `__snapshot__` of the final state as the only remaining event
5. Show idempotency: closing an already-tombstoned stream is a no-op

```ts
const result = await app.close([
  {
    stream: "counter-A",
    archive: async () => {
      const events = await app.query_array({
        stream: "counter-A",
        stream_exact: true,
        with_snaps: true,
      });
      // ship to S3, etc.
    },
  },
  { stream: "counter-B" },
  { stream: "counter-C", restart: true, archive: async () => { /* ... */ } },
]);
```

## Tests

`test/invariants.spec.ts` covers:

- Invariant violation (`Clear` on a clean calculator) → `InvariantError`
- Schema violation (numeric key) → `ValidationError`
- Custom emit-time error (`=` with no operator) → throws `"no operator"`
- Missing target stream → throws `"Missing target stream"`

Run with `pnpm test` from the root, or `pnpm -F calculator test` for this package only.

## Switching to PostgreSQL

`src/main.ts` ships configured for the default `InMemoryStore`. To run against PostgreSQL, uncomment the lines at the top of `main()`:

```ts
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({ schema: "act", table: "calculator", leaseMillis: 30_000 }));
await store().drop();
await store().seed();
```

## Related

- [`@rotorsoft/act`](../../libs/act) — core framework
- [`@act/server`](../server) — tRPC HTTP server that hosts `calculatorRouter`
- [`@act/client`](../client) — React UI that calls `PressKey` / `Clear`
- [`@act/wolfdesk`](../wolfdesk) — larger example with multiple slices and a SQLite read model
