---
id: intro
title: Act Framework
---

# Act Framework Documentation

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

## 📚 Documentation Structure

- [Examples](examples/calculator): Calculator Example
- [Examples](examples/wolfdesk): WolfDesk Example
- [API Reference (act)](api/act.src.md)
- [API Reference (act-pg)](api/act-pg.md)

## 📄 License

This documentation is part of the Act Framework project, licensed under the MIT License.

For more information, visit the [Act Framework GitHub repository](https://github.com/rotorsoft/act-root).
