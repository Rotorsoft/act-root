import { state } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod";
import * as errors from "./errors.js";
import * as schemas from "./schemas/index.js";
import { mustBeOpen, mustBeUserOrAgent } from "./ticket-invariants.js";

const creationEvents = {
  TicketOpened: schemas.events.TicketOpened,
  TicketClosed: schemas.events.TicketClosed,
  TicketResolved: schemas.events.TicketResolved,
};

export const TicketCreation = state(
  "Ticket",
  z.object({
    productId: z.uuid(),
    supportCategoryId: z.uuid(),
    priority: z.enum(schemas.Priority),
    title: z.string().min(1),
    userId: z.uuid(),
    messages: z.record(z.uuid(), schemas.Message),
    closedById: z.uuid().optional(),
    resolvedById: z.uuid().optional(),
    closeAfter: z.date().optional(),
  })
)
  .init(() => ({
    title: "",
    productId: "",
    supportCategoryId: "",
    userId: "",
    priority: schemas.Priority.Low,
    messages: {},
  }))
  .emits(creationEvents)
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

  .on("MarkTicketResolved", schemas.actions.MarkTicketResolved)
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((_, __, { actor }) => ["TicketResolved", { resolvedById: actor.id }])

  .build();
