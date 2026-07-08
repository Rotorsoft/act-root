// Shared invariants

// Partial state definitions and slices
export { TicketCreation, TicketCreationSlice } from "./ticket-creation.js";
export {
  mustBeOpen,
  mustBeUser,
  mustBeUserOrAgent,
} from "./ticket-invariants.js";
export { TicketMessaging, TicketMessagingSlice } from "./ticket-messaging.js";
export { TicketOperations, TicketOpsSlice } from "./ticket-operations.js";
// List projection (folds the full Ticket state)
export { TicketProjection } from "./ticket-projections.js";
// Timing automations (deferred reactions)
export { TicketTimersSlice } from "./ticket-timers.js";
export { TicketWebhooksSlice } from "./ticket-webhooks.js";
