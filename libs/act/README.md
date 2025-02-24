# [act](https://rotorsoft.github.io/act-root/modules/act.html) [![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act.svg)](https://www.npmjs.com/package/@rotorsoft/act)

## TODO

## Event-Driven Queue Store and Broker Architecture

### Overview

The system is designed to handle event delivery to consumers using different queue storage backends, ensuring message delivery guarantees, prioritization, and synchronization between event streams.

### Interfaces

The system defines two key interfaces:

#### `Queue<E>`

A queue represents a stream of ordered events that consumers process sequentially. The interface ensures minimal yet necessary operations:

- `stream`: Identifies the queue’s stream.
- `position`: Tracks the last acknowledged event position.
- `blocked`: Indicates whether the queue is blocked due to errors.
- `next`: Retrieves the next event to be processed.
- `enqueue(event, reaction)`: Adds an event to the queue.
- `ack(position, dequeue)`: Acknowledges event processing and optionally removes it.
- `block()`: Marks the queue as blocked due to failures.

#### `QueueStore`

The queue store manages multiple queues and fetches events from an event store:

- `fetch(register, limit)`: Retrieves new events and updates queues accordingly.
- Implements its own correlation strategy to determine how events should be assigned to different queues.

These interfaces ensure that the complexity of managing queues, event correlation, and storage backends is encapsulated within their implementations.

### In-Memory Adapter Implementation

The `InMemoryQueueStore` is a simple implementation used for testing. It manages an in-memory queue of events and correlates them based on predefined reactions. The implementation includes:

- Managing stream positions via a `_watermark`.
- Ensuring uncorrelated queues advance with new events.
- Providing a simple locking mechanism to block faulty queues.

While this implementation works for local development, real-world systems require more robust persistence mechanisms like Redis or PostgreSQL.

### Challenges in Queue Store Implementations

Implementing a production-grade queue store involves addressing several challenges:

1. **Correlated Streams and Prioritization**
   Events might need to be delivered to multiple correlated queues based on event relationships. A strategy is required to determine:

- Which queues should receive new events?
- How to prioritize event delivery across multiple queues?

2. **Advancing Watermarks in Unaffected Queues**
   Not all queues receive new events on every fetch. However, to maintain system-wide consistency, all queues need to advance their positions based on the latest known event. Otherwise, uncorrelated queues could fall behind, causing delays in processing.

3. **Concurrency and Multiple Brokers**
   When multiple brokers are fetching from the queue store and delivering events, they must:

- Ensure events are not delivered multiple times.
- Handle distributed locks or optimistic concurrency to prevent race conditions.
- Load balance event distribution among multiple brokers.

4. **Handling Failures and Retries**
   When an event fails to be processed:

- The system should retry with an exponential backoff.
- If an event repeatedly fails, the queue should be blocked to prevent further processing.

5. **Efficient Fetching and Delivery**
   Fetching events should be optimized to:

- Reduce database load by fetching only required events.
- Prioritize queues with pending events.
- Handle fetching across multiple storage backends seamlessly.

## Broker Implementation

The `Broker` class processes events fetched from the `QueueStore` by:

- Iterating over `Queue` instances and invoking handlers.
- Handling retries and blocking queues when needed.
- Ensuring atomic acknowledgment of processed events.

The broker works alongside the queue store to ensure events are delivered in an efficient and fault-tolerant manner.

The system is designed to be backend-agnostic, with a minimal interface for defining queues and queue stores while allowing complex implementations for persistence, concurrency control, and prioritization. By keeping the interfaces simple and pushing complexity into the adapters, the system remains flexible and scalable across different infrastructure choices.
