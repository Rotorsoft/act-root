import type { Invariant, Precondition } from "@rotorsoft/act";

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

/**
 * A precondition, not an invariant: it reads the payload's `messageId`. A
 * message that doesn't exist passes here, so the handler can report it as
 * `MessageNotFoundError`.
 */
export const mustBeReceiver: Precondition<
  { messages: Record<string, { to?: string }> },
  { messageId: string }
> = {
  description: "Must be receiver to ack",
  holds: ({ messageId }, state, actor) => {
    const msg = state.messages[messageId];
    return !msg || msg.to === actor?.id;
  },
};
