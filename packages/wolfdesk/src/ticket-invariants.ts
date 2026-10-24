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

export const mustNotBeOpen: Invariant<{ productId: string }> = {
  description: "Cannot open twice",
  valid: (state) => !state.productId,
};

export const mustBeDueForEscalation: Invariant<{ escalateAfter?: Date }> = {
  description: "Cannot escalate before due date",
  valid: (state) => !state.escalateAfter || state.escalateAfter <= new Date(),
};

export const mustNotBeEscalated: Invariant<{ escalationId?: string }> = {
  description: "Cannot escalate more than once",
  valid: (state) => !state.escalationId,
};

export const mustBeEscalated: Invariant<{ escalationId?: string }> = {
  description: "Cannot reassign without escalation",
  valid: (state) => !!state.escalationId,
};

export const mustBeDueForReassignment: Invariant<{ reassignAfter?: Date }> = {
  description: "Cannot reassign before due date",
  valid: (state) => !state.reassignAfter || state.reassignAfter <= new Date(),
};

export const mustNotBeAcknowledgedByAgent: Invariant<{
  userId: string;
  messages: Record<string, { from: string; wasRead?: boolean }>;
}> = {
  description: "Cannot reassign after agent acknowledged",
  valid: (state) =>
    !Object.values(state.messages).some(
      (msg) => msg.wasRead && msg.from === state.userId
    ),
};

// Preconditions read the payload too: here, the message it names.

export const messageExists: Precondition<
  { messages: Record<string, unknown> },
  { messageId: string }
> = {
  description: "Message must exist",
  holds: ({ messageId }, state) => !!state.messages[messageId],
};

export const mustBeReceiver: Precondition<
  { messages: Record<string, { to?: string }> },
  { messageId: string }
> = {
  description: "Must be receiver to ack",
  holds: ({ messageId }, state, actor) =>
    state.messages[messageId]?.to === actor?.id,
};
