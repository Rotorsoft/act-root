import type { Actor, AsCommitted } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { act } from "./bootstrap";
import { assignAgent } from "./services/agent";
import { deliverMessage } from "./services/notification";

const actor: Actor = { id: randomUUID(), name: "WolfDesk" };

export async function assign(event: AsCommitted<typeof act, "TicketOpened">) {
  const agent = assignAgent(
    event.stream,
    event.data.supportCategoryId,
    event.data.priority
  );
  await act.do("AssignTicket", { stream: event.stream, actor }, agent, event);
}

export async function deliver(event: AsCommitted<typeof act, "MessageAdded">) {
  await deliverMessage(event.data);
  await act.do(
    "MarkMessageDelivered",
    { stream: event.stream, actor },
    { messageId: event.data.messageId },
    event
  );
}

export async function escalate(
  event: AsCommitted<typeof act, "TicketEscalationRequested">
) {
  await act.do(
    "EscalateTicket",
    { stream: event.stream, actor },
    event.data,
    event
  );
}
