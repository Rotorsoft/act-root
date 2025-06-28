# Core Framework

## Background

The Act Framework orchestrates event-sourced state machines, providing a robust foundation for building reliable, auditable, and scalable applications. Event sourcing ensures that every change to application state is captured as an immutable event, allowing for complete traceability, time travel, and the ability to reconstruct state at any point. This approach is invaluable for domains requiring auditability, debugging, and historical analysis.

The framework abstracts the complexities of event management, state reconstruction, and the coordination of actions and reactions. This enables developers to focus on domain logic while leveraging powerful infrastructure for state and event handling.

## The Orchestrator: Act Class

The `Act` class is the main orchestrator for event-sourced state machines. It manages:

- Registration of state machines (your domain models)
- Event processing and storage
- Coordination of actions (commands) and reactions (side effects)
- Event stream querying and analysis

## Event Sourcing Lifecycle

1. **Action:** An actor (user, system, or agent) issues a command to a state machine.
2. **Event Emission:** The state machine validates the action and emits one or more events.
3. **Event Storage:** Events are persisted in an append-only event store.
4. **State Update:** The state machine applies events to update its state.
5. **Reactions:** Other state machines or agents can react to events, triggering further actions or integrations.
6. **Querying:** The event store can be queried for analytics, debugging, or projections.

## Traceability & Debugging

- Every state change is recorded as an event, enabling full audit trails and time travel debugging.
- Snapshots can be used to optimize state reconstruction for aggregates with long event streams.
- The framework provides utilities for querying and analyzing event streams, making it easy to understand system behavior over time.

## Best Practices

- Model your domain as small, focused state machines.
- Use reactions to decouple workflows and integrations.
- Leverage snapshots for performance in high-throughput domains.
- Use the event store for analytics, debugging, and compliance.

## When to Use Act

- When you need auditability, traceability, or compliance.
- When your domain benefits from event-driven workflows or CQRS.
- When you want to decouple business logic from infrastructure and integrations.

[API Reference (act)](../api/act.src)
