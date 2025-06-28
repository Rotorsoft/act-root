# State Management

## Background

State management is at the heart of any application that tracks and evolves data over time. In the Act Framework, state is modeled as a series of transitions driven by actions and recorded as events. This approach enables powerful features such as time travel, auditing, and debugging, as you can always reconstruct the state from its event history. Strong typing and validation ensure that state transitions are predictable and safe.

## State Definition

- Define your domain models as state machines, specifying the shape of state and how it evolves over time.
- Use Zod schemas for type-safe state definitions and validation.

## Actions & Events

- Actions represent commands to change state.
- Events are the immutable records of those changes.
- The framework provides strong typing and validation for both actions and events.

## Validation

- Business rules and invariants can be enforced at the action and event level, ensuring your domain remains consistent.
- Use Zod and custom logic to validate all transitions.

## Best Practices

- Keep state machines focused and single-purpose.
- Validate all actions and events.
- Use event history for debugging and analytics.

[API Reference (act)](../api/act.src)

[API Reference (act-pg)](../api/act-pg)
