import { ActBuilder, type AsCommitted } from "@rotorsoft/act";
import { randomUUID } from "node:crypto";
import { assignAgent } from "./services/agent";
import { deliverMessage } from "./services/notification";
import { Ticket } from "./ticket";
import * as p from "./tickets";

export * from "./errors";
export * from "./ticket";

export const builder = new ActBuilder().with(Ticket);

// prettier-ignore
export const act = builder
  // reactions
  .on("TicketOpened").do(assign)
  .on("MessageAdded").do(deliver)
  .on("TicketEscalationRequested").do(escalate)
  // tickets projection
  .on("TicketOpened").do(p.opened).to("tickets")
  .on("TicketClosed").do(p.closed).to("tickets")
  .on("TicketAssigned").do(p.assigned).to("tickets")
  .on("MessageAdded").do(p.messageAdded).to("tickets")
  .on("TicketEscalated").do(p.escalated).to("tickets")
  .on("TicketReassigned").do(p.reassigned).to("tickets")
  .on("TicketResolved").do(p.resolved).to("tickets")
  .build();

export async function assign(
  event: AsCommitted<typeof builder.events, "TicketOpened">
) {
  const agent = assignAgent(
    event.stream,
    event.data.supportCategoryId,
    event.data.priority
  );
  await act.do(
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
  await act.do(
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
  await act.do(
    "EscalateTicket",
    {
      stream: event.stream,
      actor: { id: randomUUID(), name: "escalate reaction" },
    },
    event.data,
    event
  );
}
