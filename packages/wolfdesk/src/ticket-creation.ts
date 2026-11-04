import { randomUUID } from "node:crypto";
import { slice, state } from "@rotorsoft/act";
import { Agent, agentStream } from "./agent.js";
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
import { TicketOperations } from "./ticket-operations.js";
import {
  mustBeOpen,
  mustBeUserOrAgent,
  mustNotBeOpen,
} from "./ticket-preconditions.js";

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
  .requires([mustNotBeOpen])
  .emit((data, _, { actor }) => {
    return [
      "TicketOpened",
      { ...data, userId: actor.id, messageId: randomUUID() },
    ];
  })

  // A ticket holds its agent's slot until it's resolved or closed, whichever
  // comes first, so closing frees it only when resolving hasn't.
  .on({ CloseTicket }, { maxRetries: 4 })
  .loads(Agent, (_, state) => agentStream(state.agentId), ["TicketDropped"])
  .requires([mustBeOpen])
  .emit((_, { state }, { actor }) =>
    state.agentId && !state.resolvedById
      ? [
          ["TicketClosed", { closedById: actor.id }],
          ["TicketDropped", {}],
        ]
      : ["TicketClosed", { closedById: actor.id }]
  )

  .on({ MarkTicketResolved }, { maxRetries: 4 })
  .loads(Agent, (_, state) => agentStream(state.agentId), ["TicketDropped"])
  .requires([mustBeOpen, mustBeUserOrAgent])
  .emit((_, { state }, { actor }) =>
    state.agentId && !state.resolvedById
      ? [
          ["TicketResolved", { resolvedById: actor.id }],
          ["TicketDropped", {}],
        ]
      : ["TicketResolved", { resolvedById: actor.id }]
  )

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
  .withState(Agent)
  .withState(TicketCreation)
  .withState(TicketOperations)

  .on("TicketOpened")
  .do(async function assign(event, _target, app) {
    // Waiting can outlast the need: the ticket may be done, or someone may have
    // taken it by hand.
    const { state } = await app.load("Ticket", event.stream);
    if (state.resolvedById || state.closedById || state.agentId) return;
    const agent = await assignAgent(
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
  // On its own target, since a ticket waiting for an agent mustn't hold the
  // ticket's other reactions.
  .to((event) => ({ target: `assign:${event.stream}`, source: event.stream }))
  .build();
