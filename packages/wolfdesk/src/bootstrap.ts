import { act } from "@rotorsoft/act";
import { TicketProjection } from "./ticket-projections.js";
import {
  TicketCreationSlice,
  TicketMessagingSlice,
  TicketOpsSlice,
} from "./ticket.js";

export * from "./errors.js";
export * from "./ticket.js";

// prettier-ignore
export const app = act()
  .with(TicketCreationSlice)
  .with(TicketMessagingSlice)
  .with(TicketOpsSlice)
  .with(TicketProjection)
  .build();
