import { randomUUID } from "node:crypto";
import { slice, state } from "@rotorsoft/act";
import {
  AcknowledgeMessage,
  AddMessage,
  MarkMessageDelivered,
  MessageAdded,
  MessageDelivered,
  MessageRead,
  TicketMessagingState,
} from "./schemas/ticket.schemas.js";
import { deliverMessage } from "./services/notification.js";
import {
  messageExists,
  mustBeOpen,
  mustBeReceiver,
  mustBeUserOrAgent,
} from "./ticket-preconditions.js";

// --- State ---
export const TicketMessaging = state({ Ticket: TicketMessagingState })
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

  .on({ AddMessage })
  .requires([mustBeOpen, mustBeUserOrAgent])
  .emit((data, _, { actor }) => [
    "MessageAdded",
    {
      ...data,
      from: actor.id,
      messageId: randomUUID(),
    },
  ])

  .on({ MarkMessageDelivered })
  .requires([mustBeOpen, messageExists])
  .emit("MessageDelivered")

  .on({ AcknowledgeMessage })
  .requires([mustBeOpen, messageExists, mustBeReceiver])
  .emit("MessageRead")

  .build();

// --- Slice ---
// prettier-ignore
export const TicketMessagingSlice = slice()
  .withState(TicketMessaging)

  .on("MessageAdded")
  .do(
    async function deliver(event, _stream, app) {
      await deliverMessage(event.data);
      await app.do(
        "MarkMessageDelivered",
        {
          stream: event.stream,
          actor: { id: randomUUID(), name: "deliver reaction" },
        },
        { messageId: event.data.messageId },
        { reactingTo: event }
      );
    },
    // Exponential backoff with jitter for an external delivery channel —
    // a flaky receiver shouldn't be hammered, and lockstep retries from
    // many tickets at once would just create a thundering herd.
    {
      maxRetries: 5,
      backoff: {
        strategy: "exponential",
        baseMs: 200,
        maxMs: 30_000,
        jitter: true,
      },
    }
  )
  .build();
