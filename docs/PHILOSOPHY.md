# Philosophy

The why-this-shape rationale for `@rotorsoft/act`: where the framework's three primitives (State, Actions, Reactions) come from, how they relate to existing paradigms, and why composing them this way produces useful systems.

For day-to-day API and configuration, see the project [README](../README.md). For technical decisions and trade-offs, see the [Design Decisions](../README.md#design-decisions) section.

## Where this comes from

Act draws from three traditions:

- **DDD aggregates** (Eric Evans, 2003) — the "consistent state with a boundary" idea. Each `state(...)` defines an aggregate: an entity with its own identity, the authority over its data, and a well-defined lifecycle. User profiles, orders, inventory items — distinct islands of state with clear edges.
- **Event Sourcing** (Greg Young, mid-2000s) — events as the source of truth. State is derived by replaying an immutable event log; the log is the audit trail; replay is what makes time-travel and projection rebuild possible.
- **CQRS** (also Young) — separate the write path (actions, invariants, commits) from the read path (loads, projections, queries). The framework's `action()` and `load()` are the two halves.

Reactions sit on top of these as event-driven dispatch — close in shape to publish/subscribe, with the drain pipeline as the delivery mechanism.

## Actions and Reactions: The Lifeblood of a System

Actions are the sole mechanism for altering state, ensuring atomic updates and clear audit trails. Actions serve as the catalysts for change within the system, representing the intent of actors, whether users, systems, or agents. To maintain clarity and consistency, actions must explicitly define their inputs and outputs, producing events that signal the changes to the state. By capturing these changes as immutable event streams, the system preserves a complete history, allowing state reconstruction at any point in time.

Reactions, on the other hand, define how the system responds to these changes. They drive downstream updates, trigger additional state modifications, or facilitate integrations with external systems. Reactions play a crucial role in maintaining a loosely coupled system, allowing workflows and behaviors to evolve independently. While an action may target a specific state instance, reactions can scale to address broader concerns, influencing interconnected states across varying scopes and domains, ultimately fostering systemic adaptability.

## A Simplified Flow

1. An **actor** (user or agent) initiates an action to interact with a state instance.
2. The state instance processes the action, validates it, updates its state, and emits events.
3. **Agents** react to these events, triggering additional actions or external integrations as needed.
4. Entire workflows can be tracked and potentially replayed by correlating actions and reactions throughout the system.

## Integration

To tie everything together, this approach requires a robust integration layer to route events reliably and ensure agents stay informed about system changes. A message "broker" serves as the communication backbone, facilitating event-driven interactions across the system. The integration layer must provide several key capabilities:

1. Subscriptions: Agents subscribe to relevant events, enabling them to reactively trigger workflows based on the events they receive. This allows for flexibility in processing and ensures that agents are always in sync with the latest state changes.
2. Event Delivery: Reliable event queues ensure that events are delivered to the correct agents in a timely and guaranteed manner. This includes mechanisms for retries, ensuring delivery even in the face of failures, and maintaining the correct order of events.
3. Scalability: As new agents or state instances are introduced, the system can expand without introducing tight dependencies or bottlenecks, enabling efficient handling of growing loads and complex interactions.

## Complexity Emerging from Simplicity

Living systems demonstrate that intricate behaviors and complex structures can emerge from simple, foundational building blocks. This natural principle suggests that advanced systems can be constructed from a few elemental components. The key question is whether focusing on the core concepts of state, actions, and reactions, while layering in reliability and scalability through event-driven design, provides all the essential ingredients needed to build the next generation of software agents.
