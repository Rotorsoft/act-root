import type { Precondition } from "@rotorsoft/act";

// These ignore the payload, so every ticket action can use them.

export const mustBeOpen: Precondition<
  {
    productId: string;
    closedById?: string;
  },
  unknown
> = {
  description: "Ticket must be open",
  holds: (_, state) => !!state.productId && !state.closedById,
};

export const mustBeUser: Precondition<
  {
    productId: string;
    closedById?: string;
    userId: string;
  },
  unknown
> = {
  description: "Must be the owner",
  holds: (_, state, actor) => state.userId === actor?.id,
};

export const mustBeUserOrAgent: Precondition<
  {
    productId: string;
    closedById?: string;
    userId: string;
    agentId?: string;
  },
  unknown
> = {
  description: "Must be owner or assigned agent",
  holds: (_, state, actor) =>
    state.userId === actor?.id || state.agentId === actor?.id,
};

export const mustNotBeOpen: Precondition<{ productId: string }, unknown> = {
  description: "Cannot open twice",
  holds: (_, state) => !state.productId,
};

export const mustBeDueForEscalation: Precondition<
  {
    escalateAfter?: Date;
  },
  unknown
> = {
  description: "Cannot escalate before due date",
  holds: (_, state) =>
    !state.escalateAfter || state.escalateAfter <= new Date(),
};

export const mustNotBeEscalated: Precondition<
  { escalationId?: string },
  unknown
> = {
  description: "Cannot escalate more than once",
  holds: (_, state) => !state.escalationId,
};

export const mustBeEscalated: Precondition<{ escalationId?: string }, unknown> =
  {
    description: "Cannot reassign without escalation",
    holds: (_, state) => !!state.escalationId,
  };

export const mustBeDueForReassignment: Precondition<
  {
    reassignAfter?: Date;
  },
  unknown
> = {
  description: "Cannot reassign before due date",
  holds: (_, state) =>
    !state.reassignAfter || state.reassignAfter <= new Date(),
};

export const mustNotBeAcknowledgedByAgent: Precondition<
  {
    userId: string;
    messages: Record<string, { from: string; wasRead?: boolean }>;
  },
  unknown
> = {
  description: "Cannot reassign after agent acknowledged",
  holds: (_, state) =>
    !Object.values(state.messages).some(
      (msg) => msg.wasRead && msg.from === state.userId
    ),
};

// These read the payload too: here, the message it names.

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
