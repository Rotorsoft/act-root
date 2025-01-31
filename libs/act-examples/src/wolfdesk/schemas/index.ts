import { actions } from "./ticket.action.schemas";
import { events } from "./ticket.event.schemas";
import { Ticket } from "./ticket.state.schemas";

export * as external from "./external.schemas";
export * from "./ticket.state.schemas";

export const TicketSchemas = { state: Ticket, actions, events };
