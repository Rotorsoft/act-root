# @rotorsoft/act [![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act.svg)](https://www.npmjs.com/package/@rotorsoft/act)

[Act](../../README.md) core library

## Event Store

The event store in this architecture serves as the single source of truth for system state, persisting all changes as immutable events. It acts as both a storage mechanism and a queryable event history, enabling efficient replayability, debugging, and distributed event-driven processing.

### Append-Only, Immutable Event Log

Unlike traditional databases that update records in place, the event store follows an append-only model, meaning:

- All state changes are recorded as new events, never modifying past data.
- Events are immutable, ensuring a complete historical record of all changes.
- Each event is time-stamped and versioned, allowing precise state reconstruction at any point in time.

This immutability is critical for auditability, debugging, and ensuring consistent state reconstruction across distributed systems.

### Event Streams for State Aggregation

Events are not stored in a single, monolithic table but are instead grouped into event streams, each representing a unique entity or domain process.

- Each entity instance (e.g., a user, order, or transaction) has its own stream.
- Events within a stream maintain a strict order, ensuring that state is replayed correctly.
- Streams can be dynamically created and partitioned, allowing for horizontal scalability.

For example, an Order aggregate might have a stream containing:

1. OrderCreated
2. OrderItemAdded
3. OrderItemRemoved
4. OrderShipped

A consumer reconstructing the order’s state would replay these events in order, rather than relying on a snapshot-based approach.

### Optimistic Concurrency and Versioning

Each event stream supports optimistic concurrency control by maintaining a version number per stream.

- When appending an event, the system verifies that the stream’s version matches the expected version.
- If another process has written an event in the meantime, the append operation is rejected to prevent race conditions.
- Consumers can retry with the latest stream state, preventing lost updates.

This ensures strong consistency in distributed systems without requiring heavyweight locks.

### Querying

Events in the store can be retrieved via two primary methods:

- Stream-based retrieval (load): Fetching all events for a given stream in order.
- Query: Provides multiple ways to filter and sort events, enabling efficient state reconstruction.

This enables both on-demand querying for state reconstruction and real-time processing for event-driven architectures.

### Snapshots for Efficient State Reconstruction

Replaying all events from the beginning for every request can be inefficient. To optimize state reconstruction:

- Snapshots are periodically stored, capturing the computed state of an entity.
- When retrieving an entity’s state, the system first loads the latest snapshot and replays only newer events.
- This reduces query time while maintaining full event traceability.

For example, instead of replaying 1,000 events for an account balance, the system might load a snapshot with the latest balance and only apply the last few transactions.

### Event Storage Backend

The event store can be implemented using different storage solutions, depending on system requirements:

- Relational Databases (PostgreSQL, MySQL): Storing events in an append-only table with indexing for fast retrieval.
- NoSQL Databases (Cassandra, DynamoDB, MongoDB): Using key-value or document stores to manage streams efficiently.
- Event-Specific Databases (EventStoreDB, Kafka, Pulsar): Purpose-built for high-performance event sourcing with built-in subscriptions and replication.

### Indexing and Retrieval Optimization

To ensure high performance when querying events:

- Events are indexed by stream ID and timestamp for fast lookups.
- Materialized views can be used for common queries (e.g., the latest event per stream).
- Partitioning strategies help distribute event streams across multiple nodes, improving scalability.

### Retention and Archival

Since event data grows indefinitely, a retention policy is needed:

- Active event streams remain in fast storage for quick access.
- Older events are archived in cold storage while keeping snapshots for quick recovery.
- Event compression techniques can be used to reduce storage overhead without losing historical data.

## Event-Driven Processing with Stream Leasing and Correlation

This architecture is designed to handle event-driven workflows efficiently while ensuring ordered and non-duplicated event processing. Instead of a queueing system, it dynamically processes events from an event store and correlates them with specific event streams. The approach improves scalability, fault tolerance, and event visibility while maintaining strong guarantees for event processing.

### Event-Centric Processing Instead of Queues

Rather than storing messages in a queue and tracking explicit positions, this architecture treats the event store as the single source of truth. Events are written once and can be consumed by multiple independent consumers. This decoupling allows:

- Independent consumers that can process the same event stream in different ways.
- Efficient event querying without maintaining redundant queue states.
- Flexible event correlation, where consumers can derive dependencies dynamically rather than following a strict order.

### Stream Leasing for Ordered Event Processing

Each consumer does not simply fetch and process events immediately; instead, events are fetched by the application and pushed to consumers by leasing the events of each correlated stream. Leasing prevents multiple consumers from processing the same event concurrently, ensuring:

- Per-stream ordering, where events related to a specific stream are processed sequentially.
- Temporary ownership of events, allowing retries if a lease expires before acknowledgment.
- Backpressure control, as only a limited number of leases can be active at a time, preventing overwhelming consumers.

If a lease expires due to failure or unresponsiveness, the event can be re-leased to another consumer, ensuring no event is permanently lost.

### Event Correlation and Dynamic Stream Resolution

A key challenge in event-driven systems is understanding which stream an event belongs to and how it should be processed. Instead of hardcoding event routing logic, this system enables:

- Dynamic correlation, where events are linked to streams based on resolver functions.
- Multi-stream dependency tracking, allowing one event to trigger multiple related processes.
- Implicit event grouping, ensuring that related events are processed in the correct sequence.

For example, if an event pertains to a transaction across multiple users, the system can determine which user streams should handle it dynamically.

### Parallel Execution with Retry and Blocking Strategies

While events are processed in an ordered fashion within a stream, multiple streams can be processed concurrently. The architecture includes:

- Parallel event handling, improving throughput by distributing processing load.
- Retry mechanisms with exponential backoff, ensuring transient failures do not cause data loss.
- Blocking strategies, where streams with consistent failures can be temporarily halted to prevent cascading errors.

A stream is only blocked after exhausting a configurable number of retries, reducing the risk of infinite failure loops.

### Draining and Acknowledgment for Fault Tolerance

Once an event has been successfully processed, it is acknowledged to release its lease.
This design ensures:

- Consumers only process new work, reducing idle resource usage.
- Failure recovery without manual intervention, as failed events can be re-leased automatically.
- Clear event lifecycle management, with visibility into pending, processing, and completed events.

### Persistent Event Store with Optimized Querying

Since events are stored persistently rather than transiently queued, the system must efficiently query and retrieve relevant events. The event store supports:

- Efficient filtering, allowing consumers to retrieve only the events relevant to them.
- Indexing strategies for fast lookups, optimizing performance for high-volume event processing.
- Retention policies, ensuring historical event data is accessible for audits without overloading the system.

### Real-Time Notifications and Asynchronous Processing

To reduce polling overhead, the system can utilize real-time event notifications via database triggers or a pub-sub mechanism. This allows consumers to:

- React to new events immediately, improving responsiveness.
- Reduce unnecessary database queries, optimizing system performance.
- Enable distributed event processing, where multiple instances can coordinate workload distribution.

### Scalable Consumer Management

As the system scales, multiple consumer instances may need to process events in parallel. The architecture ensures that:

- Each consumer instance handles an exclusive subset of events, avoiding conflicts.
- Leases distribute events evenly across consumers, preventing hotspots.
- Idle consumers are dynamically assigned new workloads, ensuring efficient resource utilization.

## Dual-Frontier Drain

In event-sourced systems, consumers often subscribe to multiple event streams.
These streams advance at different rates: some produce bursts of events, while others may stay idle for long periods.
New streams can also be discovered while proccesing events from existing streams.

The following issues arise:

- Strictly serial processing across all streams would block fast streams.
- Fully independent processing risks inconsistent states.
- Prioritizing new streams over existing ones risks missing important events.

Act addresses this with the Dual-Frontier Drain strategy.

### Key features

- Dynamic correlation
  - Event resolvers dynamically correlate streams as new events arrive.
  - Resolvers can include a source regex to limit matched streams by name.
  - When a new stream matching the resolver is discovered, it is added immediately to the drain process.
- Dual frontiers
  - Each drain cycle calculates two sets of streams:
    - Leading frontier – streams already near the latest known event (the global frontier).
    - Lagging frontier – streams behind or newly discovered.
- Fast-forwarding lagging streams
  - Lagging streams are advanced quickly. If they have no matching events in the current window, their watermarks are advanced using the leading watermarks.
  - This prevents stale streams from blocking global convergence.
- Parallel processing
  - While lagging streams catch up, leading streams continue processing without waiting.
  - All reactions eventually converge on the global frontier.

### Why it matters

- Fast recovery: Newly discovered or previously idle streams catch up quickly.
- No global blocking: Fast streams are never paused to wait for slower ones.
- Consistent state: All reactions end up aligned on the same event position.
