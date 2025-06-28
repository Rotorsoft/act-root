# WolfDesk Example

This example demonstrates a ticketing system (WolfDesk) built with the Act Framework. It highlights complex workflows, state management, and event-driven design.

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

## Usage

See the source files above for implementation details and usage examples.

[API Reference (act)](../api/act.src)
