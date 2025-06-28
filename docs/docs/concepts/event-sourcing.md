# Event Sourcing

## Background

Event sourcing is a design pattern in which all changes to application state are stored as a sequence of events. This provides a complete audit trail, enables state reconstruction at any point in time, and supports advanced scenarios like temporal queries, projections, and debugging. By persisting events in an append-only store, the framework ensures data integrity and enables powerful analytics and compliance capabilities.

## Event Storage

- All events are persisted in an append-only store, providing a complete audit trail of all state changes.
- Events are immutable and can be replayed to reconstruct state at any point in time.

## Snapshot Management

- Snapshots can be used to optimize state reconstruction for aggregates with long event streams.
- Snapshots store the state at a point in time, reducing the need to replay all events from the beginning.

## Event Queries

- Query event streams for analysis, debugging, or building projections.
- Temporal queries and projections enable advanced analytics and reporting.

## Best Practices

- Design events to be immutable and self-descriptive.
- Use snapshots for performance in high-throughput domains.
- Leverage event queries for analytics, debugging, and compliance.

## When to Use Event Sourcing

- When you need a complete audit trail of all state changes.
- When your domain benefits from time travel, debugging, or analytics.
- When you want to enable advanced workflows and projections.

[API Reference (act)](../api/act.src)
