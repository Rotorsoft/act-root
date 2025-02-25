import { ActBuilder, BrokerBuilder } from "@rotorsoft/act";
import * as j from "./jobs";
import * as r from "./reactions";
import { Ticket } from "./ticket";
import * as p from "./tickets";

export * from "./errors";
export * from "./ticket";

export const act = new ActBuilder().with(Ticket).build();

// prettier-ignore
export function connect_broker(withProjection = false) {
  const builder = new BrokerBuilder(act.events)
    .when("TicketOpened").do(r.assign)
    .when("MessageAdded").do(r.deliver)
    .when("TicketEscalationRequested").do(r.escalate)

  // tickets
  withProjection && builder
    .when("TicketOpened").do(p.opened).to("tickets")
    .when("TicketClosed").do(p.closed).to("tickets")
    .when("TicketAssigned").do(p.assigned).to("tickets")
    .when("MessageAdded").do(p.messageAdded).to("tickets")
    .when("TicketEscalated").do(p.escalated).to("tickets")
    .when("TicketReassigned").do(p.reassigned).to("tickets")
    .when("TicketResolved").do(p.resolved).to("tickets")

  return builder.build();
}

export function start_jobs() {
  setInterval(j.AutoReassign, 10_000);
  setInterval(j.AutoEscalate, 10_000);
  setInterval(j.AutoClose, 15_000);
}
