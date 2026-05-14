import { randomUUID } from "node:crypto";
import { InvariantError, slice, state } from "@rotorsoft/act";
import * as errors from "./errors.js";
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
import { mustBeOpen, mustBeUserOrAgent } from "./ticket-invariants.js";

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
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((data, _, { actor }) => [
    "MessageAdded",
    {
      ...data,
      from: actor.id,
      messageId: randomUUID(),
    },
  ])

  .on({ MarkMessageDelivered })
  .given([mustBeOpen])
  .emit((data, { state }) => {
    if (!state.messages[data.messageId])
      throw new errors.MessageNotFoundError(data.messageId);
    return ["MessageDelivered", data];
  })

  .on({ AcknowledgeMessage })
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
        event
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
