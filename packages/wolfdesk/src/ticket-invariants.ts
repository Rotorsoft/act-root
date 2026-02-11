import { type Invariant } from "@rotorsoft/act";
import { z } from "zod";
import * as schemas from "./schemas/index.js";

export type TicketState = z.infer<typeof schemas.Ticket>;

export const ticketInit = (): TicketState => ({
  title: "",
  productId: "",
  supportCategoryId: "",
  userId: "",
  priority: schemas.Priority.Low,
  messages: {},
});

export const mustBeOpen: Invariant<TicketState> = {
  description: "Ticket must be open",
  valid: (state) => !!state.productId && !state.closedById,
};

export const mustBeUser: Invariant<TicketState> = {
  description: "Must be the owner",
  valid: (state, actor) => state.userId === actor?.id,
};

export const mustBeUserOrAgent: Invariant<TicketState> = {
  description: "Must be owner or assigned agent",
  valid: (state, actor) =>
    state.userId === actor?.id || state.agentId === actor?.id,
};
