import { type Target } from "@rotorsoft/act";
import { Chance } from "chance";
import { app } from "../../src/wolfdesk/bootstrap";
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
  app.do("OpenTicket", target, {
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
  app.do("AssignTicket", target, {
    agentId,
    escalateAfter,
    reassignAfter,
  });

export const closeTicket = (target: Target) =>
  app.do("CloseTicket", target, {});

export const addMessage = (
  target: Target,
  body: string,
  to = chance.guid()
) => {
  const snap = app.do("AddMessage", target, {
    body,
    to,
    attachments: {},
  });
  return snap;
};

export const requestTicketEscalation = (target: Target) =>
  app.do("RequestTicketEscalation", target, {});

export const escalateTicket = (
  target: Target,
  requestId = chance.guid(),
  requestedById = chance.guid()
) => app.do("EscalateTicket", target, { requestId, requestedById });

export const reassignTicket = (
  target: Target,
  agentId = chance.guid(),
  escalateAfter = oneDay(),
  reassignAfter = oneDay()
) =>
  app.do("ReassignTicket", target, {
    agentId,
    escalateAfter,
    reassignAfter,
  });

export const markMessageDelivered = (target: Target, messageId: string) =>
  app.do("MarkMessageDelivered", target, { messageId });

export const acknowledgeMessage = (target: Target, messageId: string) =>
  app.do("AcknowledgeMessage", target, { messageId });

export const markTicketResolved = (target: Target) =>
  app.do("MarkTicketResolved", target, {});
