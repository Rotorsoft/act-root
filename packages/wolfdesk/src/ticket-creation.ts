import { slice, state, ZodEmpty } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod";
import * as errors from "./errors.js";
import { Message, Priority } from "./schemas/ticket.state.schemas.js";
import { assignAgent } from "./services/agent.js";
import { mustBeOpen, mustBeUserOrAgent } from "./ticket-invariants.js";
import { TicketOperations } from "./ticket-operations.js";

// --- Action schemas ---
const OpenTicket = z
  .object({
    productId: z.uuid(),
    supportCategoryId: z.uuid(),
    priority: z.enum(Priority),
    title: z.string().min(1),
    message: z.string().min(1),
    closeAfter: z.date().optional(),
  })
  .describe("Opens a new ticket");
const CloseTicket = ZodEmpty.describe("Closes the ticket");
const MarkTicketResolved = ZodEmpty.describe("Flags ticket as resolved");

// --- Event schemas ---
const TicketOpened = OpenTicket.and(
  z.object({ userId: z.uuid(), messageId: z.uuid() })
).describe("A new ticket was opened");
const TicketClosed = z
  .object({ closedById: z.uuid() })
  .describe("The ticket was closed");
const TicketResolved = z
  .object({ resolvedById: z.uuid() })
  .describe("The ticket was marked as resolved");

// --- State ---
export const TicketCreation = state(
  "Ticket",
  z.object({
    productId: z.uuid(),
    supportCategoryId: z.uuid(),
    priority: z.enum(Priority),
    title: z.string().min(1),
    userId: z.uuid(),
    messages: z.record(z.uuid(), Message),
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

  .on("OpenTicket", OpenTicket)
  .emit((data, { state }, { stream, actor }) => {
    if (state.productId) throw new errors.TicketCannotOpenTwiceError(stream);
    return [
      "TicketOpened",
      { ...data, userId: actor.id, messageId: randomUUID() },
    ];
  })

  .on("CloseTicket", CloseTicket)
  .given([mustBeOpen])
  .emit((_, __, { actor }) => ["TicketClosed", { closedById: actor.id }])

  .on("MarkTicketResolved", MarkTicketResolved)
  .given([mustBeOpen, mustBeUserOrAgent])
  .emit((_, __, { actor }) => ["TicketResolved", { resolvedById: actor.id }])

  .build();

// --- Slice ---
// prettier-ignore
export const TicketCreationSlice = slice()
  .with(TicketCreation)
  .with(TicketOperations)
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
