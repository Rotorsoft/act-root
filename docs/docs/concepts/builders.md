# Builders

## Background

Builders in this framework provide a fluent, type-safe API for composing complex state machines and applications. The ActBuilder and StateBuilder abstractions allow you to declaratively register states, actions, events, and reactions, making it easier to model your domain and enforce business rules. This approach encourages modularity and reusability, and helps ensure that your application logic remains clear and maintainable as it grows.

## ActBuilder

A fluent API for composing applications with states and reactions. Use ActBuilder to register state machines, configure reactions, and build your application.

## StateBuilder

Define state machines with actions, events, and validation logic. StateBuilder provides a type-safe way to model your domain, specify how actions produce events, and how events update state.

[API Reference (act)](../api/act.src)

[API Reference (act-pg)](../api/act-pg)
