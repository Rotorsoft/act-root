**Act Framework Documentation v0.3.0**

---

# Act Framework Documentation

👉 **[View the Interactive Landing Page](../landing/index.html)** 👈

Welcome to the Act Framework documentation! Act is a modern, event-sourced framework for building scalable, maintainable applications using the principles of Domain-Driven Design (DDD), Command Query Responsibility Segregation (CQRS), and Event Sourcing.

## 🎯 What is Act?

Act is a TypeScript framework that simplifies the development of event-sourced applications by providing:

- **State Machines**: Define your domain models as strongly-typed state machines
- **Event Sourcing**: Automatically capture all state changes as immutable events
- **Reactions**: Build reactive systems that respond to events across your domain
- **Type Safety**: Full TypeScript support with compile-time guarantees
- **Scalability**: Designed for high-performance, distributed systems

## 🏗️ Core Concepts

### Actions → State ← Reactions

Act follows a simple but powerful pattern:

1. **Actions**: Commands that represent intent to change state
2. **State**: The current state of your domain objects
3. **Reactions**: Responses to state changes that can trigger additional actions

This pattern enables you to build complex, event-driven systems while maintaining clarity and testability.

## 📚 Documentation Structure

This documentation is organized into the following sections:

### Core Framework

- **Act Class**: The main orchestrator for event-sourced state machines
- **Event Management**: How events are processed and committed
- **State Loading**: Loading and reconstructing state from event streams

### Builders

- **ActBuilder**: Fluent API for composing applications with states and reactions
- **StateBuilder**: Define state machines with actions, events, and validation

### State Management

- **State Definition**: How to define your domain models as state machines
- **Actions & Events**: Working with actions and their resulting events
- **Validation**: Business rules and invariants

### Event Sourcing

- **Event Storage**: How events are persisted and retrieved
- **Snapshot Management**: Optimizing state reconstruction with snapshots
- **Event Queries**: Querying event streams for analysis and debugging

### Utilities

- **State Patching**: Utilities for updating state immutably
- **Validation**: Schema validation and error handling
- **Async Helpers**: Utilities for working with asynchronous operations

### Configuration

- **Environment Setup**: Configuration management for different environments
- **Logging**: Structured logging and debugging tools

### Ports & Adapters

- **Store Adapters**: Pluggable storage backends
- **Resource Management**: Lifecycle management for external resources

## 🚀 Quick Start

Here's a simple example to get you started:

```typescript
import { act, state, z } from "@rotorsoft/act";

// Define a counter state machine
const Counter = state("Counter", z.object({ count: z.number() }))
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: (event, state) => ({ count: state.count + event.amount }),
  })
  .on("increment", z.object({ by: z.number() }))
  .emit((action) => ["Incremented", { amount: action.by }])
  .build();

// Create an application
const app = act().with(Counter).build();

// Use the application
const actor = { id: "user1", name: "User" };
await app.do("increment", { stream: "counter1", actor }, { by: 5 });
const state = await app.load(Counter, "counter1");
console.log(state.state); // { count: 5 }
```

## 📖 Examples

Check out our comprehensive examples:

- **[Calculator](./examples/calculator/)**: A simple calculator with event tracking
- **[WolfDesk](./examples/wolfdesk/)**: A ticketing system demonstrating complex workflows

## 🔧 Development

### Building Documentation

```bash
# Generate documentation
pnpm docs:generate

# Serve documentation locally
pnpm docs:serve

# Clean generated docs
pnpm docs:clean
```

### Contributing

When contributing to the documentation:

1. Add JSDoc comments to your code using the `/** ... */` format
2. Include `@param`, `@returns`, `@template`, and `@example` tags where appropriate
3. Use the `@category` tag to organize your documentation
4. Run `pnpm docs:generate` to regenerate the documentation

## 📄 License

This documentation is part of the Act Framework project, licensed under the MIT License.

---

For more information, visit the [Act Framework GitHub repository](https://github.com/rotorsoft/act-root).
