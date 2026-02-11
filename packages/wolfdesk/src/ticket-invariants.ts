import { type Invariant } from "@rotorsoft/act";

export const mustBeOpen: Invariant<{
  productId: string;
  closedById?: string;
}> = {
  description: "Ticket must be open",
  valid: (state) => !!state.productId && !state.closedById,
};

export const mustBeUser: Invariant<{
  productId: string;
  closedById?: string;
  userId: string;
}> = {
  description: "Must be the owner",
  valid: (state, actor) => state.userId === actor?.id,
};

export const mustBeUserOrAgent: Invariant<{
  productId: string;
  closedById?: string;
  userId: string;
  agentId?: string;
}> = {
  description: "Must be owner or assigned agent",
  valid: (state, actor) =>
    state.userId === actor?.id || state.agentId === actor?.id,
};
