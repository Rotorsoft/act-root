# Ports & Adapters

## Background

The Ports & Adapters (Hexagonal) architecture decouples the core logic of your application from external systems such as databases, message queues, or web services. By defining clear interfaces (ports) and providing interchangeable implementations (adapters), this pattern enables flexibility, testability, and maintainability. In the Act Framework, store adapters allow you to swap out storage backends without changing your business logic, and resource management ensures that external connections are handled efficiently and safely.

## Store Adapters

- Pluggable storage backends allow you to use different databases or event stores with the same application code.
- Easily switch between in-memory and persistent stores (e.g., Postgres) for development, testing, and production.

## Resource Management

- Lifecycle management for external resources, such as database connections or message queues, is handled through a consistent interface.
- Proper resource management ensures reliability and prevents leaks or connection exhaustion.

## Best Practices

- Define clear interfaces for all external dependencies.
- Use adapters to isolate infrastructure concerns from business logic.
- Test with in-memory adapters and deploy with production-grade stores.

[API Reference (act)](../api/act.src)
