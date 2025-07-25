import { InvariantError, state, type Invariant } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod";
import * as errors from "./errors.js";
import * as schemas from "./schemas/index.js";

type TicketState = z.infer<typeof schemas.Ticket>;

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

export const Ticket = state("Ticket", schemas.Ticket)
  .init(() => ({
    title: "",
    productId: "",
    supportCategoryId: "",
    userId: "",
    priority: schemas.Priority.Low,
    messages: {},
  }))
  .emits(schemas.events)
  .patch({
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
  })

  .on("OpenTicket", schemas.actions.OpenTicket)
  .emit((data, { state }, { stream, actor }) => {
    if (state.productId) throw new errors.TicketCannotOpenTwiceError(stream);
    return [
      "TicketOpened",
      { ...data, userId: actor.id, messageId: randomUUID() },
    ];
  })

  .on("CloseTicket", schemas.actions.CloseTicket)
  .given([mustBeOpen])
  .emit((_, __, { actor }) => ["TicketClosed", { closedById: actor.id }])

  .on("AssignTicket", schemas.actions.AssignTicket)
  .given([mustBeOpen])
  .emit((data) => ["TicketAssigned", data])

  .on("AddMessage", schemas.actions.AddMessage)
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((data, _, { actor }) => [
    "MessageAdded",
    {
      ...data,
      from: actor.id,
      messageId: randomUUID(),
    },
  ])

  .on("RequestTicketEscalation", schemas.actions.RequestTicketEscalation)
  .given([mustBeOpen, mustBeUser])
  .emit((_, { state }, { stream, actor }) => {
    // escalation can only be requested after window expired
    if (state.escalateAfter && state.escalateAfter > new Date())
      throw new errors.TicketEscalationError(
        stream,
        actor?.id || "",
        "Cannot escalate before due date"
      );
    return [
      "TicketEscalationRequested",
      {
        requestedById: actor.id,
        requestId: randomUUID(),
      },
    ];
  })

  .on("EscalateTicket", schemas.actions.EscalateTicket)
  .given([mustBeOpen])
  .emit((data, { state }, { stream, actor }) => {
    // only if ticket has not been escalated before?
    if (state.escalationId)
      throw new errors.TicketEscalationError(
        stream,
        actor?.id || "",
        "Cannot escalate more than once"
      );
    return ["TicketEscalated", { ...data, escalationId: randomUUID() }];
  })

  .on("ReassignTicket", schemas.actions.ReassignTicket)
  .given([mustBeOpen])
  .emit((data, { state }, { stream, actor }) => {
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
    return ["TicketReassigned", data];
  })

  .on("MarkMessageDelivered", schemas.actions.MarkMessageDelivered)
  .given([mustBeOpen])
  .emit((data, { state }) => {
    if (!state.messages[data.messageId])
      throw new errors.MessageNotFoundError(data.messageId);
    return ["MessageDelivered", data];
  })

  .on("AcknowledgeMessage", schemas.actions.AcknowledgeMessage)
  .given([mustBeOpen])
  .emit((data, snapshot, { stream, actor }) => {
    const msg = snapshot.state.messages[data.messageId];
    if (!msg) throw new errors.MessageNotFoundError(data.messageId);

    // message can only be acknowledged by receiver
    if (msg.to !== actor?.id)
      throw new InvariantError(
        "AcknowledgeMessage",
        data,
        { stream, actor },
        snapshot,
        "Must be receiver to ack"
      );
    return ["MessageRead", data];
  })

  .on("MarkTicketResolved", schemas.actions.MarkTicketResolved)
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((_, __, { actor }) => ["TicketResolved", { resolvedById: actor.id }])

  .build();
