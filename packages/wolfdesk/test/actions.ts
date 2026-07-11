import type { Target } from "@rotorsoft/act";
import { Chance } from "chance";
import type { app as ProdApp } from "../src/bootstrap.js";
import { Priority } from "../src/schemas/index.js";

const chance = new Chance();
const DAY = 24 * 60 * 60 * 1000;
const oneDay = () => new Date(Date.now() + DAY);

/** The scoped Act each suite builds via `sandbox(builder, …)`. */
type App = typeof ProdApp;

export const target = (
  userId = chance.guid(),
  ticketId = chance.guid()
): Target => ({
  stream: ticketId,
  actor: { id: userId, name: "actor" },
});

/**
 * Bind the ticket action helpers to a specific (scoped) Act. Each suite
 * builds its own isolated app with `sandbox(builder)` and calls this to get
 * helpers that dispatch against that app — never the singleton port.
 */
export const makeActions = (app: App) => {
  const openTicket = (
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

  const assignTicket = (
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

  const closeTicket = (target: Target) => app.do("CloseTicket", target, {});

  const addMessage = async (target: Target, body: string, to = chance.guid()) =>
    app.do("AddMessage", target, {
      body,
      to,
      attachments: {},
    });

  const requestTicketEscalation = (target: Target) =>
    app.do("RequestTicketEscalation", target, {});

  const escalateTicket = (
    target: Target,
    requestId = chance.guid(),
    requestedById = chance.guid()
  ) => app.do("EscalateTicket", target, { requestId, requestedById });

  const reassignTicket = (
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

  const markMessageDelivered = (target: Target, messageId: string) =>
    app.do("MarkMessageDelivered", target, { messageId });

  const acknowledgeMessage = (target: Target, messageId: string) =>
    app.do("AcknowledgeMessage", target, { messageId });

  const markTicketResolved = (target: Target) =>
    app.do("MarkTicketResolved", target, {});

  return {
    openTicket,
    assignTicket,
    closeTicket,
    addMessage,
    requestTicketEscalation,
    escalateTicket,
    reassignTicket,
    markMessageDelivered,
    acknowledgeMessage,
    markTicketResolved,
  };
};

export type Actions = ReturnType<typeof makeActions>;
