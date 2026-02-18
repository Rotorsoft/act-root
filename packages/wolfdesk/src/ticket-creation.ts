import { slice, state } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import * as errors from "./errors.js";
import {
  CloseTicket,
  MarkTicketResolved,
  OpenTicket,
  Priority,
  TicketClosed,
  TicketCreationState,
  TicketOpened,
  TicketResolved,
} from "./schemas/ticket.schemas.js";
import { assignAgent } from "./services/agent.js";
import { mustBeOpen, mustBeUserOrAgent } from "./ticket-invariants.js";
import { TicketOperations } from "./ticket-operations.js";

// --- State ---
export const TicketCreation = state({ Ticket: TicketCreationState })
  .init(() => ({
    title: "",
    productId: "",
    supportCategoryId: "",
    userId: "",
    priority: Priority.Low,
    messages: {},
  }))
  .emits({ TicketOpened, TicketClosed, TicketResolved })
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
    TicketResolved: ({ data }) => data,
  })

  .on({ OpenTicket })
  .emit((data, { state }, { stream, actor }) => {
    if (state.productId) throw new errors.TicketCannotOpenTwiceError(stream);
    return [
      "TicketOpened",
      { ...data, userId: actor.id, messageId: randomUUID() },
    ];
  })

  .on({ CloseTicket })
  .given([mustBeOpen])
  .emit((_, __, { actor }) => ["TicketClosed", { closedById: actor.id }])

  .on({ MarkTicketResolved })
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((_, __, { actor }) => ["TicketResolved", { resolvedById: actor.id }])

  .build();

// --- Slice ---
// prettier-ignore
export const TicketCreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)

  .on("TicketOpened").do(async function assign(event, _stream, app) {
    const agent = assignAgent(
      event.stream,
      event.data.supportCategoryId,
      event.data.priority
    );
    await app.do(
      "AssignTicket",
      {
        stream: event.stream,
        actor: { id: randomUUID(), name: "assign reaction" },
      },
      agent,
      event
    );
  })
  .build();
