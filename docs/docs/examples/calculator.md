---
id: calculator
title: Calculator
---

# Calculator Example

A simple calculator demonstrating core Act patterns: state machines, multiple event types, conditional emit logic, invariants, and snapshotting.

**Source:** [packages/calculator/src/](https://github.com/rotorsoft/act-root/tree/master/packages/calculator/src)

**See it animated:** [Calculator flows](pathname:///flows/calculator.html) plays key presses through the calculator state and the two reactions in `main.ts` that count digits and record results, in three scenarios: a sum, decimals and clear, and refusals with a division by zero. [How these are made](../guides/flow-animations.md).

## Patterns Demonstrated

### Single State Machine

The calculator is a single state with left/right operands, an operator, and a result:

```typescript no-check
const State = z.object({
  left: z.string().optional(),
  right: z.string().optional(),
  operator: z.enum(["+", "-", "*", "/"]).optional(),
  result: z.number(),
});

const Calculator = state({ Calculator: State })
  .init(() => ({ result: 0 }))
  // ...
```

### Multiple Event Types from One Action

A single `PressKey` action emits different events based on the key pressed. Pressing `=` with nothing to compute is refused by a precondition: a rule that reads the action's payload (the key) as well as the state, declared with `.requires(...)` and checked before the handler runs:

```typescript no-check
.on({ PressKey: z.object({ key: z.enum(KEYS) }) })
  .requires([{
    description: "Equals needs an operator",
    holds: ({ key }, state) => key !== "=" || !!state.operator,
  }])
  .emit(({ key }) => {
    if (key === ".") return ["DotPressed", {}];
    if (key === "=") return [["EqualsPressed", {}]]; // an array of tuples = multi-event commit
    return DIGITS.includes(key)
      ? ["DigitPressed", { digit: key }]
      : ["OperatorPressed", { operator: key }];
  })
```

### Custom Patch Reducers

Each event type has its own reducer logic:

```typescript no-check
.patch({
  DigitPressed: ({ data }, state) => append(state, data.digit),
  OperatorPressed: ({ data }, state) => compute(state, data.operator),
  DotPressed: (_, state) => {
    const current = state.operator ? state.right || "" : state.left || "";
    if (current.includes(".")) return {};  // no-op
    return append(state, ".");
  },
  EqualsPressed: (_, state) => compute(state),
  Cleared: () => ({ result: 0, left: undefined, right: undefined, operator: undefined }),
})
```

### Invariants

The `Clear` action enforces that the calculator has state to clear. That rule reads only the state, so it's an invariant, declared with `.given(...)`:

```typescript no-check
.on({ Clear: ZodEmpty })
  .given([{
    description: "Must be dirty",
    valid: (state) => !!state.left || !!state.right || !!state.result || !!state.operator,
  }])
  .emit(() => ["Cleared", {}])
```

### Snapshotting

Snapshots are taken every 12 events for cold-start performance:

```typescript no-check
.snap((s) => s.patches > 12)
```

### ZodEmpty

Events and actions with no payload use `ZodEmpty`:

```typescript
import { ZodEmpty } from "@rotorsoft/act";

const Events = {
  DotPressed: ZodEmpty,
  EqualsPressed: ZodEmpty,
  Cleared: ZodEmpty,
};
```

## Running

```bash
pnpm dev:calculator
pnpm -F calculator test
```

## Over the wire — multi-transport demo

The calculator also backs `packages/server` and `packages/client`, where the same `calculatorApp` is exposed simultaneously over **tRPC**, **Hono REST**, and an **OpenAPI** document — all generated from one registry via `@rotorsoft/act-http`. The Vite client offers a transport toggle so you can press a key over tRPC, then the same key over REST, and watch both hit the same stream:

```bash
pnpm dev:http     # boots server (:4000) + client (:3000)
```

- Client UI: [http://localhost:3000](http://localhost:3000) (with the tRPC/REST toggle and an API-docs link)
- Server landing page: [http://localhost:4000](http://localhost:4000)
- Interactive API docs: [http://localhost:4000/docs](http://localhost:4000/docs) (Scalar reference reading the live `/openapi.json`)

See the [auto-generated API guide](../guides/auto-generated-api.md) for the narrative on what each transport does and how to wire your own auth seam into the generators.
