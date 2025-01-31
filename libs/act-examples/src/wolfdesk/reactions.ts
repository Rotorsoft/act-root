import type { AsCommitted } from "@rotorsoft/act";
import { act } from "./app";
import { assignAgent } from "./services/agent";
import { deliverMessage } from "./services/notification";

export async function assign(event: AsCommitted<typeof act, "TicketOpened">) {
  const agent = assignAgent(
    event.stream,
    event.data.supportCategoryId,
    event.data.priority
  );
  await act.do("AssignTicket", { stream: event.stream }, agent, event);
}

export async function deliver(event: AsCommitted<typeof act, "MessageAdded">) {
  await deliverMessage(event.data);
  await act.do(
    "MarkMessageDelivered",
    { stream: event.stream },
    { messageId: event.data.messageId },
    event
  );
}

export async function escalate(
  event: AsCommitted<typeof act, "TicketEscalationRequested">
) {
  await act.do("EscalateTicket", { stream: event.stream }, event.data, event);
}
