import { InvariantError, state } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import * as errors from "./errors.js";
import * as schemas from "./schemas/index.js";
import {
  mustBeOpen,
  mustBeUserOrAgent,
  ticketInit,
} from "./ticket-invariants.js";

const messagingEvents = {
  MessageAdded: schemas.events.MessageAdded,
  MessageDelivered: schemas.events.MessageDelivered,
  MessageRead: schemas.events.MessageRead,
};

export const TicketMessaging = state("Ticket", schemas.Ticket)
  .init(ticketInit)
  .emits(messagingEvents)
  .patch({
    MessageAdded: ({ data }) => ({
      messages: { [data.messageId]: { ...data } },
    }),
    MessageDelivered: ({ data }) => ({
      messages: { [data.messageId]: { wasDelivered: true } },
    }),
    MessageRead: ({ data }) => ({
      messages: { [data.messageId]: { wasRead: true } },
    }),
  })

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

  .build();
