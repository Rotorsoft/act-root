import { act, slice, type AsCommitted } from "@rotorsoft/act";
import { randomUUID } from "node:crypto";
import { assignAgent } from "./services/agent.js";
import { deliverMessage } from "./services/notification.js";
import { TicketCreation, TicketMessaging, TicketOperations } from "./ticket.js";
import * as p from "./tickets.js";

export * from "./errors.js";
export * from "./ticket.js";

// Slices: self-contained vertical features with scoped reactions
// prettier-ignore
const TicketCreationSlice = slice()
  .with(TicketCreation)
  .on("TicketOpened").do(p.opened).to("tickets")
  .on("TicketClosed").do(p.closed).to("tickets")
  .on("TicketResolved").do(p.resolved).to("tickets")
  .build();

// prettier-ignore
const TicketMessagingSlice = slice()
  .with(TicketMessaging)
  .on("MessageAdded").do(p.messageAdded).to("tickets")
  .build();

// prettier-ignore
const TicketOpsSlice = slice()
  .with(TicketOperations)
  .on("TicketAssigned").do(p.assigned).to("tickets")
  .on("TicketEscalated").do(p.escalated).to("tickets")
  .on("TicketReassigned").do(p.reassigned).to("tickets")
  .build();

// Act: compose slices + orchestration reactions (these call app.do)
export const builder = act()
  .with(TicketCreationSlice)
  .with(TicketMessagingSlice)
  .with(TicketOpsSlice);

// prettier-ignore
export const app = builder
  .on("TicketOpened").do(assign)
  .on("MessageAdded").do(deliver)
  .on("TicketEscalationRequested").do(escalate)
  .build();

// Orchestration reaction handlers
export async function assign(
  event: AsCommitted<typeof builder.events, "TicketOpened">
) {
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
}

export async function deliver(
  event: AsCommitted<typeof builder.events, "MessageAdded">
) {
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
}

export async function escalate(
  event: AsCommitted<typeof builder.events, "TicketEscalationRequested">
) {
  await app.do(
    "EscalateTicket",
    {
      stream: event.stream,
      actor: { id: randomUUID(), name: "escalate reaction" },
    },
    event.data,
    event
  );
}
