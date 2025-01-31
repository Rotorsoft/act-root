import { type Target } from "@rotorsoft/act";
import { Chance } from "chance";
import { act } from "../../src/wolfdesk/app";
import { Priority } from "../../src/wolfdesk/ticket";

const chance = new Chance();
const DAY = 24 * 60 * 60 * 1000;
const oneDay = () => new Date(Date.now() + DAY);

export const target = (
  userId = chance.guid(),
  ticketId = chance.guid()
): Target => ({
  stream: ticketId,
  actor: { id: userId, name: "actor" },
});

export const openTicket = (
  target: Target,
  title: string,
  message: string,
  productId = chance.guid(),
  supportCategoryId = chance.guid(),
  priority = Priority.Low,
  closeAfter = oneDay()
) =>
  act.do("OpenTicket", target, {
    productId,
    supportCategoryId,
    priority,
    title,
    message,
    closeAfter,
  });

export const assignTicket = (
  target: Target,
  agentId = chance.guid(),
  escalateAfter = oneDay(),
  reassignAfter = oneDay()
) =>
  act.do("AssignTicket", target, {
    agentId,
    escalateAfter,
    reassignAfter,
  });

export const closeTicket = (target: Target) =>
  act.do("CloseTicket", target, {});

export const addMessage = (
  target: Target,
  body: string,
  to = chance.guid()
) => {
  const snap = act.do("AddMessage", target, {
    body,
    to,
    attachments: {},
  });
  return snap;
};

export const requestTicketEscalation = (target: Target) =>
  act.do("RequestTicketEscalation", target, {});

export const escalateTicket = (
  target: Target,
  requestId = chance.guid(),
  requestedById = chance.guid()
) => act.do("EscalateTicket", target, { requestId, requestedById });

export const reassignTicket = (
  target: Target,
  agentId = chance.guid(),
  escalateAfter = oneDay(),
  reassignAfter = oneDay()
) =>
  act.do("ReassignTicket", target, {
    agentId,
    escalateAfter,
    reassignAfter,
  });

export const markMessageDelivered = (target: Target, messageId: string) =>
  act.do("MarkMessageDelivered", target, { messageId });

export const acknowledgeMessage = (target: Target, messageId: string) =>
  act.do("AcknowledgeMessage", target, { messageId });

export const markTicketResolved = (target: Target) =>
  act.do("MarkTicketResolved", target, {});
