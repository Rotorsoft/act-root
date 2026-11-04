# @act/rules

Rules that span streams, each as a small state: one action loads the states its decision needs and commits its events to all of them at once, or to none.

> Workspace package, not published. Run the tour with `pnpm dev:rules` from the monorepo root.

## The scenarios

| Pattern | Scenario | Source | Rule held by |
|---|---|---|---|
| A unique value | User email: register, change, deactivate, erase | [`unique-values.ts`](src/unique-values.ts) | a precondition over `Email` |
| | Vehicle plate, never reissued | [`unique-values.ts`](src/unique-values.ts) | a precondition over `Plate` |
| | A token redeemed once | [`unique-values.ts`](src/unique-values.ts) | a precondition over `Token` |
| | One review per customer per product | [`unique-values.ts`](src/unique-values.ts) | a precondition over `Review` |
| A count limit | Course capacity, which can be lowered | [`count-limits.ts`](src/count-limits.ts) | a precondition over `Seats` |
| | A student's maximum courses | [`count-limits.ts`](src/count-limits.ts) | the `StudentLoad` schema |
| | Sessions per user, freed at logout or by a timer | [`count-limits.ts`](src/count-limits.ts) | the `UserSessions` schema |
| | Gapless invoice numbers | [`count-limits.ts`](src/count-limits.ts) | the version check on `InvoiceCounter` |
| Another state's schema | Room booking, no overlap | [`state-schemas.ts`](src/state-schemas.ts) | the `Room` schema |
| | Invoice payments, never more than the invoice | [`state-schemas.ts`](src/state-schemas.ts) | the `Invoice` schema |
| | Inventory, with expired holds freed by a timer | [`state-schemas.ts`](src/state-schemas.ts) | a precondition and the `Product` schema |
| | Bike rental | [`state-schemas.ts`](src/state-schemas.ts) | a precondition over `Bike` |
| Several streams | Money transfer, one state loaded twice | [`several-streams.ts`](src/several-streams.ts) | a precondition over `from` |
| | Library loans | [`several-streams.ts`](src/several-streams.ts) | a precondition over `Copy` |
| A read | The displayed price | [`reads.ts`](src/reads.ts) | a precondition, not guarded |

Each has tests in [`test/`](test/) that play its rule, its refusal, and its race where it has one. See [Rules across streams](https://rotorsoft.github.io/act-root/docs/concepts/state-management#rules-across-streams-loads) for how `.loads` works.

## Choosing where a rule goes

- **In a precondition,** when the caller needs a clear refusal, or when the limit can change. `Seats` can be lowered below the seats taken: those enrolled keep theirs and new ones are refused, so its schema can't say `taken <= capacity`.
- **In the loaded state's schema,** when it must hold whichever action emits. `Room` refuses an overlap from any path.
- **In both,** when you want both. `Product` has a precondition for the clear message, and a schema that keeps stock at zero or above.

## Things these show

- **Freeing a value is an action.** `app.close` runs no action, so `Deactivate` frees the address, then the stream can close. Closing without it keeps the address taken.
- **A stream name can't be forgotten.** `Email` streams are named by an HMAC of the address, and `User` keeps that name in its state, not the address. After `app.forget`, the address is nowhere in the store, and the value's stream still works.
- **Input can name one stream twice.** A transfer to the same account refuses with `PreconditionError`, before any rule runs.
- **A rival on a loaded stream fails the whole commit.** `maxRetries` runs the action again with fresh loads, and the rule sees the new state.
