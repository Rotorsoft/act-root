# Event Sourcing

## Background

Event sourcing is a design pattern in which all changes to application state are stored as a sequence of events. This provides a complete audit trail, enables state reconstruction at any point in time, and supports advanced scenarios like temporal queries and projections. By persisting events in an append-only store, the framework ensures data integrity and enables powerful analytics and debugging capabilities.

## Event Storage

All events are persisted in an append-only store, providing a complete audit trail of all state changes.

## Snapshot Management

Snapshots can be used to optimize state reconstruction for aggregates with long event streams.

## Event Queries

Query event streams for analysis, debugging, or building projections.

[API Reference (act)](../api/act.src)
