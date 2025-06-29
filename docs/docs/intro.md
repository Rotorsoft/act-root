---
id: intro
title: Act Framework
---

# Act Framework

Welcome to the Act Framework documentation! Act is a modern, event-sourced framework for building scalable, maintainable, and auditable applications in TypeScript. Act is inspired by the best ideas from Domain-Driven Design (DDD), Command Query Responsibility Segregation (CQRS), and Event Sourcing, but is designed to be simple, composable, and highly type-safe.

## 🎯 Purpose & Philosophy

**Act** aims to make event-sourced, reactive architectures accessible and productive for all TypeScript developers. It provides a minimal, functional core for modeling your domain as state machines, capturing every change as an immutable event, and reacting to those changes in a scalable, testable way.

- **Simplicity:** Focus on the essentials—state, actions, and reactions—without boilerplate or code generation.
- **Type Safety:** Leverage TypeScript and Zod for compile-time guarantees and runtime validation.
- **Composability:** Build complex workflows by composing small, testable state machines and reactions.
- **Auditability:** Every state change is an event, enabling time travel, debugging, and compliance.
- **Adaptability:** Easily swap storage backends, integrate with external systems, and scale from in-memory to production databases.

## 🚀 Why Act?

- **Event Sourcing Made Easy:** Model your domain as a series of state transitions, with every change captured as an event.
- **Functional State Machines:** Define state, actions, and events as pure functions—no classes or decorators required.
- **Reactive by Default:** Build workflows and integrations by reacting to events, not just commands.
- **Production-Ready:** Includes adapters for in-memory and Postgres event stores, with robust resource management.
- **Minimal Footprint:** No codegen, no runtime bloat, and a tiny bundle size.

## 🏗️ Core Concepts

### Actions → State ← Reactions

Act follows a simple but powerful pattern:

1. **Actions:** Commands that represent intent to change state (e.g., user input, API calls).
2. **State:** The current state of your domain objects, modeled as immutable data.
3. **Reactions:** Responses to state changes that can trigger additional actions, side effects, or integrations.

This pattern enables you to build complex, event-driven systems while maintaining clarity, testability, and auditability.

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

## 📚 Documentation Map

- Concepts: All main ideas and architecture
  - [State Management](concepts/state-management)
  - [Event Sourcing](concepts/event-sourcing)
  - [Configuration, Builders, Adapters & Utilities](concepts/configuration)
- Examples
  - [Calculator](examples/calculator)
  - [WolfDesk](examples/wolfdesk)
- API Reference
  - [act](api/act.src)
  - [act-pg](api/act-pg.md)

## ❓ FAQ

**Q: Do I need to use Postgres?**  
A: No. You can start with the in-memory store and switch to Postgres or another backend as needed.

**Q: Is Act only for DDD experts?**  
A: No. Act is designed to be approachable for all TypeScript developers, with a focus on simplicity and strong typing.

## 📄 License

This documentation is part of the Act Framework project, licensed under the MIT License.

For more information, visit the [Act Framework GitHub repository](https://github.com/rotorsoft/act-root).
