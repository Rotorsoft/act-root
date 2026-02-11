import type { z } from "zod";
import type { TicketCreation } from "./ticket-creation.js";
import type { TicketMessaging } from "./ticket-messaging.js";
import type { TicketOperations } from "./ticket-operations.js";

/** Full merged ticket state type derived from the three slice schemas */
export type TicketState = z.infer<typeof TicketCreation.state> &
  z.infer<typeof TicketMessaging.state> &
  z.infer<typeof TicketOperations.state>;

// Shared invariants
export {
  mustBeOpen,
  mustBeUser,
  mustBeUserOrAgent,
} from "./ticket-invariants.js";

// Partial state definitions
export { TicketCreation } from "./ticket-creation.js";
export { TicketMessaging } from "./ticket-messaging.js";
export { TicketOperations } from "./ticket-operations.js";

// Backward-compatible alias: app.load() resolves the merged state by name
export { TicketCreation as Ticket } from "./ticket-creation.js";
