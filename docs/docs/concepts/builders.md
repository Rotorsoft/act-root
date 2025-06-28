# Builders

## Background

Builders in the Act Framework provide a fluent, type-safe API for composing complex state machines and applications. The `ActBuilder` and `StateBuilder` abstractions allow you to declaratively register states, actions, events, and reactions, making it easier to model your domain and enforce business rules. This approach encourages modularity and reusability, and helps ensure that your application logic remains clear and maintainable as it grows.

## ActBuilder

The `ActBuilder` is a fluent API for composing applications with states and reactions. Use it to:

- Register one or more state machines
- Configure reactions to events
- Build your application for execution or testing

**Example:**

```typescript
const app = act()
  .with(Counter)
  .with(AnotherState)
  .on("EventName")
  .do(async (event) => {
    /* ... */
  })
  .to(() => "TargetStream")
  .build();
```

## StateBuilder

The `StateBuilder` is used to define state machines with actions, events, and validation logic. It provides a type-safe way to model your domain, specify how actions produce events, and how events update state.

**Example:**

```typescript
const Counter = state("Counter", z.object({ count: z.number() }))
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: (event, state) => ({ count: state.count + event.amount }),
  })
  .on("increment", z.object({ by: z.number() }))
  .emit((action) => ["Incremented", { amount: action.by }])
  .build();
```

## Best Practices

- Keep state machines focused and single-purpose.
- Use builder chaining for clarity and composability.
- Validate all actions and events with schemas.

[API Reference (act)](../api/act.src)

[API Reference (act-pg)](../api/act-pg)
