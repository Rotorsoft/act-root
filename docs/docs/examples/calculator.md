---
id: calculator
title: Calculator
---

# Calculator Example

A simple calculator demonstrating core Act patterns: state machines, multiple event types, conditional emit logic, invariants, and snapshotting.

**Source:** [packages/calculator/src/](https://github.com/rotorsoft/act-root/tree/master/packages/calculator/src)

## Patterns Demonstrated

### Single State Machine

The calculator is a single state with left/right operands, an operator, and a result:

```typescript
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

A single `PressKey` action emits different events based on the key pressed:

```typescript
.on({ PressKey: z.object({ key: z.enum(KEYS) }) })
  .emit(({ key }, { state }) => {
    if (key === ".") return ["DotPressed", {}];
    if (key === "=") return [["EqualsPressed", {}]];  // array of tuples
    return DIGITS.includes(key)
      ? ["DigitPressed", { digit: key }]
      : ["OperatorPressed", { operator: key }];
  })
```

### Custom Patch Reducers

Each event type has its own reducer logic:

```typescript
.patch({
  DigitPressed: ({ data }, state) => append(state, data.digit),
  OperatorPressed: ({ data }, state) => compute(state, data.operator),
  DotPressed: (_, state) => {
    const current = state.operator ? state.right : state.left;
    if (current?.includes(".")) return {};  // no-op
    return append(state, ".");
  },
  EqualsPressed: (_, state) => compute(state),
  Cleared: () => ({ result: 0, left: undefined, right: undefined, operator: undefined }),
})
```

### Invariants

The `Clear` action enforces that the calculator has state to clear:

```typescript
.on({ Clear: ZodEmpty })
  .given([{
    description: "Must be dirty",
    valid: (state) => !!state.left || !!state.right || !!state.result || !!state.operator,
  }])
  .emit(() => ["Cleared", {}])
```

### Snapshotting

Snapshots are taken every 12 events for cold-start performance:

```typescript
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
