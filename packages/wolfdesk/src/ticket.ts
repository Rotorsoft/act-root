// Shared invariants and types
export {
  mustBeOpen,
  mustBeUser,
  mustBeUserOrAgent,
  ticketInit,
  type TicketState,
} from "./ticket-invariants.js";

// Partial state definitions
export { TicketCreation } from "./ticket-creation.js";
export { TicketMessaging } from "./ticket-messaging.js";
export { TicketOperations } from "./ticket-operations.js";

// Backward-compatible alias: app.load() resolves the merged state by name
export { TicketCreation as Ticket } from "./ticket-creation.js";
