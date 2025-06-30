# WolfDesk Example

This example demonstrates a ticketing system (WolfDesk) built with the Act Framework. It highlights complex workflows, state management, and event-driven design, and shows how to model real-world business processes using state machines and events.

## What You'll Learn

- How to model a ticketing system as a set of state machines
- How to define actions, events, and reactions for complex workflows
- How to use schemas for validation and type safety
- How to test and run the example

## Source Files

- [main.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/main.ts): Example usage and entry point
- [ticket.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/ticket.ts): Ticket domain logic
- [tickets.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/tickets.ts): Ticket collection logic
- [bootstrap.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/bootstrap.ts): Initialization logic
- [jobs.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/jobs.ts): Background jobs
- [errors.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/errors.ts): Error definitions

### Schemas

- [external.schemas.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/schemas/external.schemas.ts)
- [ticket.state.schemas.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/schemas/ticket.state.schemas.ts)
- [ticket.action.schemas.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/schemas/ticket.action.schemas.ts)
- [ticket.event.schemas.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/schemas/ticket.event.schemas.ts)

### Services

- [agent.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/services/agent.ts)
- [notification.ts](https://github.com/rotorsoft/act-root/blob/master/packages/wolfdesk/src/services/notification.ts)

## How It Works

1. The ticket state machine models the lifecycle of a support ticket.
2. Actions represent user or system commands (create, assign, resolve, etc.).
3. Events are emitted for each action and drive state transitions.
4. Reactions and background jobs automate workflows and notifications.

## Usage

See the source files above for implementation details and usage examples.
