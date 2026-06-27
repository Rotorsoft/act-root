import { randomUUID } from "node:crypto";
import { slice, state } from "@rotorsoft/act";
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

  // Online close-the-books policy (the operator recipes reference this
  // declaration instead of redefining a toy ticket). A ticket retires
  // 90 days after it closes or resolves — the return / dispute /
  // customer-success window — with a 365-day retention floor so a
  // ticket that never reaches a terminal event still can't linger
  // forever. The two paths fire independently (AND group OR backstop).
  .autocloses({
    is: ["TicketClosed", "TicketResolved"],
    after: { days: 90 },
    or: { after: { days: 365 } },
  })

  .build();

// --- Slice ---
// prettier-ignore
export const TicketCreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)

  .on("TicketOpened")
  .do(async function assign(event, _stream, app) {
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
      { reactingTo: event }
    );
  })
  .build();
