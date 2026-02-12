import { act } from "@rotorsoft/act";
import * as p from "./ticket-projections.js";
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
  .on("TicketOpened").do(p.opened).to("tickets")
  .on("TicketClosed").do(p.closed).to("tickets")
  .on("TicketResolved").do(p.resolved).to("tickets")
  .on("MessageAdded").do(p.messageAdded).to("tickets")
  .on("TicketAssigned").do(p.assigned).to("tickets")
  .on("TicketEscalated").do(p.escalated).to("tickets")
  .on("TicketReassigned").do(p.reassigned).to("tickets")
  .build();
