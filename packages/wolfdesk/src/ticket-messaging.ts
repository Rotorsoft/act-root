import { InvariantError, slice, state } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod";
import * as errors from "./errors.js";
import { Attachment, Message } from "./schemas/ticket.state.schemas.js";
import { deliverMessage } from "./services/notification.js";
import { mustBeOpen, mustBeUserOrAgent } from "./ticket-invariants.js";

// --- Action schemas ---
const AddMessage = z
  .object({
    to: z.uuid(),
    body: z.string().min(1),
    attachments: z.record(z.url(), Attachment),
  })
  .describe("Add a new message to the ticket");
const MarkMessageDelivered = z
  .object({ messageId: z.uuid() })
  .describe("Flags a message as delivered");
const AcknowledgeMessage = z
  .object({ messageId: z.uuid() })
  .describe("Flags the message as read");

// --- Event schemas ---
const MessageAdded = AddMessage.and(
  z.object({ from: z.uuid(), messageId: z.uuid() })
).describe("A user added a message to the ticket");
const MessageDelivered = MarkMessageDelivered.describe(
  "The message was delivered to the recepient"
);
const MessageRead = AcknowledgeMessage.describe(
  "The message was acknoledged by the recipient"
);

// --- State ---
export const TicketMessaging = state(
  "Ticket",
  z.object({
    productId: z.uuid(),
    userId: z.uuid(),
    messages: z.record(z.uuid(), Message),
  })
)
  .init(() => ({
    productId: "",
    userId: "",
    messages: {},
  }))
  .emits({ MessageAdded, MessageDelivered, MessageRead })
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

  .on("AddMessage", AddMessage)
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((data, _, { actor }) => [
    "MessageAdded",
    {
      ...data,
      from: actor.id,
      messageId: randomUUID(),
    },
  ])

  .on("MarkMessageDelivered", MarkMessageDelivered)
  .given([mustBeOpen])
  .emit((data, { state }) => {
    if (!state.messages[data.messageId])
      throw new errors.MessageNotFoundError(data.messageId);
    return ["MessageDelivered", data];
  })

  .on("AcknowledgeMessage", AcknowledgeMessage)
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

// --- Slice ---
// prettier-ignore
export const TicketMessagingSlice = slice()
  .with(TicketMessaging)
  .on("MessageAdded").do(async function deliver(event, _stream, app) {
    await deliverMessage(event.data);
    await app.do(
      "MarkMessageDelivered",
      {
        stream: event.stream,
        actor: { id: randomUUID(), name: "deliver reaction" },
      },
      { messageId: event.data.messageId },
      event
    );
  })
  .build();
