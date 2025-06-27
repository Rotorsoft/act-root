# State Management

## Background
State management is at the heart of any application that tracks and evolves data over time. In this framework, state is modeled as a series of transitions driven by actions and recorded as events. This approach enables powerful features such as time travel, auditing, and debugging, as you can always reconstruct the state from its event history. Strong typing and validation ensure that state transitions are predictable and safe.

## State Definition

Define your domain models as state machines, specifying the shape of state and how it evolves over time.

## Actions & Events

Actions represent commands to change state. Events are the immutable records of those changes. The framework provides strong typing and validation for both.

## Validation

Business rules and invariants can be enforced at the action and event level, ensuring your domain remains consistent.

[API Reference (act)](../api/act.src.md)

[API Reference (act-pg)](/docs/api/act-pg)
