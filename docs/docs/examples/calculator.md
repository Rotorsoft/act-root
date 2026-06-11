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

A single `PressKey` action emits different events based on the key pressed. Note the `=` branch reads `snapshot.state.operator` and throws if there's nothing to compute — invariants run before the emit handler, but action-side preconditions on dynamic state can also be enforced inside `.emit()`:

```typescript
.on({ PressKey: z.object({ key: z.enum(KEYS) }) })
  .emit(({ key }, { state }) => {
    if (key === ".") return ["DotPressed", {}];
    if (key === "=") {
      if (!state.operator) throw Error("no operator");
      return [["EqualsPressed", {}]]; // an array of tuples = multi-event commit
    }
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
    const current = state.operator ? state.right || "" : state.left || "";
    if (current.includes(".")) return {};  // no-op
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

## Over the wire — multi-transport demo

The calculator also backs `packages/server` and `packages/client`, where the same `calculatorApp` is exposed simultaneously over **tRPC**, **Hono REST**, and an **OpenAPI** document — all generated from one registry via `@rotorsoft/act-http`. The Vite client offers a transport toggle so you can press a key over tRPC, then the same key over REST, and watch both hit the same stream:

```bash
pnpm dev:http     # boots server (:4000) + client (:3000)
```

- Client UI: [http://localhost:3000](http://localhost:3000) (with the tRPC/REST toggle and an API-docs link)
- Server landing page: [http://localhost:4000](http://localhost:4000)
- Interactive API docs: [http://localhost:4000/docs](http://localhost:4000/docs) (Scalar reference reading the live `/openapi.json`)

See the [auto-generated API guide](../guides/auto-generated-api.md) for the narrative on what each transport does and how to wire your own auth seam into the generators.
