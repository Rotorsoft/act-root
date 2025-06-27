# Core Framework

## Background
The core framework of this project is designed to orchestrate event-sourced state machines, providing a robust foundation for building reliable, auditable, and scalable applications. Event sourcing ensures that every change to the application state is captured as an immutable event, allowing for complete traceability and the ability to reconstruct state at any point in time. This approach is particularly valuable in domains where auditability, debugging, and historical analysis are important. The framework abstracts the complexities of event management, state reconstruction, and coordination of actions and reactions, enabling developers to focus on domain logic while leveraging powerful infrastructure for state and event handling.

## Act Class

The main orchestrator for event-sourced state machines. It manages the registration of state machines, event processing, and coordination of actions and reactions.

## Event Management

Events are processed and committed to the event store, ensuring all state changes are captured as immutable events. The framework provides utilities for querying and analyzing event streams.

## State Loading

State is reconstructed from event streams, allowing you to rebuild the current state of any domain object at any time. Snapshots can be used to optimize this process for large streams.

[API Reference (act)](../api/act.src.md)
