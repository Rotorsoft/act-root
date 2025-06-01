import { InvariantError, type Infer, type Invariant } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import * as errors from "./errors";
import { Priority, TicketSchemas } from "./schemas";

type TicketState = z.infer<typeof TicketSchemas.state>;

const mustBeOpen: Invariant<TicketState> = {
  description: "Ticket must be open",
  valid: (state) => !!state.productId && !state.closedById,
};

const mustBeUser: Invariant<TicketState> = {
  description: "Must be the owner",
  valid: (state, actor) => state.userId === actor?.id,
};

const mustBeUserOrAgent: Invariant<TicketState> = {
  description: "Must be owner or assigned agent",
  valid: (state, actor) =>
    state.userId === actor?.id || state.agentId === actor?.id,
};

export { Priority };

export function Ticket(): Infer<typeof TicketSchemas> {
  return {
    ...TicketSchemas,
    init: () => ({
      title: "",
      productId: "",
      supportCategoryId: "",
      userId: "",
      priority: Priority.Low,
      messages: {},
    }),

    patch: {
      TicketOpened: ({ data }) => {
        const { message, messageId, userId, ...other } = data;
        return {
          ...other,
          userId,
          messages: {
            [messageId]: {
              messageId,
              from: userId,
              body: message,
              attachments: {},
            },
          },
        };
      },
      TicketClosed: ({ data }) => data,
      TicketAssigned: ({ data }) => data,
      MessageAdded: ({ data }) => ({
        messages: { [data.messageId]: { ...data } },
      }),
      TicketEscalationRequested: ({ data }) => data,
      TicketEscalated: ({ data }) => data,
      TicketReassigned: ({ data }) => data,
      MessageDelivered: ({ data }) => ({
        messages: { [data.messageId]: { wasDelivered: true } },
      }),
      MessageRead: ({ data }) => ({
        messages: { [data.messageId]: { wasRead: true } },
      }),
      TicketResolved: ({ data }) => data,
    },

    given: {
      CloseTicket: [mustBeOpen],
      AssignTicket: [mustBeOpen],
      AddMessage: [mustBeOpen, mustBeUserOrAgent],
      RequestTicketEscalation: [mustBeOpen, mustBeUser],
      EscalateTicket: [mustBeOpen],
      ReassignTicket: [mustBeOpen],
      MarkMessageDelivered: [mustBeOpen],
      AcknowledgeMessage: [mustBeOpen],
      MarkTicketResolved: [mustBeOpen, mustBeUserOrAgent],
    },

    on: {
      OpenTicket: (data, state, { stream, actor }) => {
        if (state.productId)
          throw new errors.TicketCannotOpenTwiceError(stream);
        return Promise.resolve([
          "TicketOpened",
          {
            ...data,
            userId: actor.id,
            messageId: randomUUID(),
          },
        ]);
      },
      CloseTicket: (_, __, { actor }) =>
        Promise.resolve(["TicketClosed", { closedById: actor.id }]),
      AssignTicket: (data) => Promise.resolve(["TicketAssigned", data]),
      AddMessage: (data, _, { actor }) =>
        Promise.resolve([
          "MessageAdded",
          {
            ...data,
            from: actor.id,
            messageId: randomUUID(),
          },
        ]),
      RequestTicketEscalation: (_, state, { stream, actor }) => {
        // escalation can only be requested after window expired
        if (state.escalateAfter && state.escalateAfter > new Date())
          throw new errors.TicketEscalationError(
            stream,
            actor?.id || "",
            "Cannot escalate before due date"
          );
        return Promise.resolve([
          "TicketEscalationRequested",
          {
            requestedById: actor.id,
            requestId: randomUUID(),
          },
        ]);
      },
      EscalateTicket: (data, state, { stream, actor }) => {
        // only if ticket has not been escalated before?
        if (state.escalationId)
          throw new errors.TicketEscalationError(
            stream,
            actor?.id || "",
            "Cannot escalate more than once"
          );
        return Promise.resolve([
          "TicketEscalated",
          { ...data, escalationId: randomUUID() },
        ]);
      },
      ReassignTicket: (data, state, { stream, actor }) => {
        // is escalated
        if (!state.escalationId)
          throw new errors.TicketEscalationError(
            stream,
            actor?.id || "",
            "Cannot reassign without escalation"
          );
        // after reassignment window
        if (state.reassignAfter && state.reassignAfter > new Date())
          throw new errors.TicketReassingmentError(
            stream,
            actor?.id || "",
            "Cannot reassign before due date"
          );
        // no message acknowledged by agent
        const ackedByAgent = Object.values(state.messages).filter(
          (msg) => msg.wasRead && msg.from === state.userId
        ).length;
        if (ackedByAgent)
          throw new errors.TicketReassingmentError(
            stream,
            actor?.id || "",
            "Cannot reassign after agent acknowledged"
          );
        return Promise.resolve(["TicketReassigned", data]);
      },
      MarkMessageDelivered: (data, state) => {
        if (!state.messages[data.messageId])
          throw new errors.MessageNotFoundError(data.messageId);
        return Promise.resolve(["MessageDelivered", data]);
      },
      AcknowledgeMessage: (data, state, { stream, actor }) => {
        const msg = state.messages[data.messageId];
        if (!msg) throw new errors.MessageNotFoundError(data.messageId);

        // message can only be acknowledged by receiver
        if (msg.to !== actor?.id)
          throw new InvariantError(
            "AcknowledgeMessage",
            data,
            { stream, actor },
            "Must be receiver to ack"
          );
        return Promise.resolve(["MessageRead", data]);
      },
      MarkTicketResolved: (_, __, { actor }) =>
        Promise.resolve(["TicketResolved", { resolvedById: actor.id }]),
    },
  };
}
