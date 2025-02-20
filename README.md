# Act

![Build Status](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml/badge.svg?branch=master)
[![Coverage Status](https://coveralls.io/repos/github/Rotorsoft/act-root/badge.svg?branch=master)](https://coveralls.io/github/Rotorsoft/act-root?branch=master)

The complexity of modern software design often arises from over-engineering abstractions and paradigms that, while powerful, can be difficult to grasp and apply coherently. This project is an attempt to distill the basic building blocks of modern software design into a small, simple, and composable library.

## `Actions` -> `{ State }` <- `Reactions`

Looking back at the history of software development, a few fundamental questions arise:

- What is the simplest way to think about the systems we build?
- How do we balance clarity and composability without sacrificing scalability and flexibility?
- Can we design systems that are easier to reason about while still capable of handling complexity?

When you break it all down, any system seems to distill into three fundamental concepts:

- **State**: The data we care about.
- **Actions**: The changes we want to make.
- **Reactions**: The things that happen as a result.

## Timeless Ideas, Modern Context

In the earliest days of computing, the “Actor Model” offered a simple yet powerful mental framework: entities with their own state, processing messages asynchronously. Similarly, event-driven programming showed how reactions to changes could create more dynamic and decoupled systems. Could we take inspiration from the simplicity of the “Actor Model” while integrating modern concepts like “Event Sourcing” and “CQRS” to form the backbone of consistency and integration for the next generation of autonomous systems?

At its core, any software system is a collection of "consistent states" interacting with one another. Each instance has its unique identity, clear boundaries serving as the authority over its data, and a well-defined lifecycle. Examples include a user profile, an order, or an inventory item. While we often call these "entities", "aggregates", or "domain objects", at their essence, they are all distinct islands of state.

## Actions and Reactions: The Lifeblood of a System

Actions are the sole mechanism for altering state, ensuring atomic updates and clear audit trails. Actions serve as the catalysts for change within the system, representing the intent of actors, whether users, systems, or agents. To maintain clarity and consistency, actions must explicitly define their inputs and outputs, producing events that signal the changes to the state. By capturing these changes as immutable event streams, the system preserves a complete history, allowing state reconstruction at any point in time.

Reactions, on the other hand, define how the system responds to these changes. They drive downstream updates, trigger additional state modifications, or facilitate integrations with external systems. Reactions play a crucial role in maintaining a loosely coupled system, allowing workflows and behaviors to evolve independently. While an action may target a specific state instance, reactions can scale to address broader concerns, influencing interconnected states across varying scopes and domains, ultimately fostering systemic adaptability.

## A Simplified Flow

1. An **actor** (user or agent) initiates an action to interact with a state instance.
2. The state instance processes the action, validates it, updates its state, and emits events.
3. **Agents** react to these events, triggering additional actions or external integrations as needed.
4. Entire workflows can be tracked and potentially replayed by correlating actions and reactions throughout the system.

## Integration

To tie everything together, this approach requires a robust integration layer to route events reliably and ensure agents stay informed about system changes. A message “broker” serves as the communication backbone, facilitating event-driven interactions across the system. The integration layer must provide several key capabilities:

1. Subscriptions: Agents subscribe to relevant events, enabling them to reactively trigger workflows based on the events they receive. This allows for flexibility in processing and ensures that agents are always in sync with the latest state changes.
2. Event Delivery: Reliable event queues ensure that events are delivered to the correct agents in a timely and guaranteed manner. This includes mechanisms for retries, ensuring delivery even in the face of failures, and maintaining the correct order of events.
3. Scalability: As new agents or state instances are introduced, the system can expand without introducing tight dependencies or bottlenecks, enabling efficient handling of growing loads and complex interactions.

## Complexity Emerging from Simplicity

Living systems demonstrate that intricate behaviors and complex structures can emerge from simple, foundational building blocks. This natural principle suggests that advanced systems can be constructed from a few elemental components. The key question is whether focusing on the core concepts of state, actions, and reactions, while layering in reliability and scalability through event-driven design, provides all the essential ingredients needed to build the next generation of software agents.

## Examples

To demonstrate the capabilities of this framework, we provide a library of examples with test cases:

- The first example is a simple [calculator](./libs/act-examples/src/calculator/) where actions represent key presses, and a counter tracks how many times the “9” and “=” keys have been pressed in response to events.
- The second example is a reference implementation of the [WolfDesk](./libs/act-examples/src//wolfdesk/) ticketing system, as proposed by Vlad Khononov in his book [Learning Domain-Driven Design](https://a.co/d/1udDtcE).
- Additionally, we include tRPC-based client and server packages that outline the basic steps for exposing the calculator as a web application.

Enjoy!
