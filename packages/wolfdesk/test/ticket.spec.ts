import { dispose } from "@rotorsoft/act";
import { Chance } from "chance";
import { app } from "../src/bootstrap.js";
import { Ticket, type TicketState } from "../src/ticket.js";
import {
  acknowledgeMessage,
  addMessage,
  assignTicket,
  closeTicket,
  escalateTicket,
  markMessageDelivered,
  markTicketResolved,
  openTicket,
  reassignTicket,
  requestTicketEscalation,
  target,
} from "./actions.js";

const chance = new Chance();

describe("ticket without reactions", () => {
  afterAll(async () => {
    await dispose()();
  });

  const t = target();
  const agentId = chance.guid();
  const to = chance.guid();
  const title = "happy path";
  let messageId: string;

  it("should open, assign, add message, and escalate", async () => {
    await openTicket(t, title, "Opening a new ticket");
    await assignTicket(t, agentId, new Date(), new Date());

    const [s] = await addMessage(t, "first message", to);
    const message = Object.values(s.state.messages).at(-1);
    expect(message?.from).toEqual(t.actor?.id);
    messageId = message!.messageId!;

    await requestTicketEscalation(t);
    await escalateTicket(t);

    const snapshot = await app.load(Ticket, t.stream);
    const s1 = snapshot.state as TicketState;
    expect(s1.title).toEqual(title);
    expect(s1.agentId).toBeDefined();
    expect(Object.keys(s1.messages).length).toBe(2);
    expect(snapshot.patches).toBeGreaterThanOrEqual(5);
  });

  it("should reassign, mark message delivered, acknowledge, and resolve", async () => {
    await reassignTicket(t);
    await markMessageDelivered(t, messageId);
    await acknowledgeMessage(target(to, t.stream), messageId);
    await markTicketResolved(t);
    await closeTicket(t);

    const snapshot2 = await app.load(Ticket, t.stream);
    const s2 = snapshot2.state as TicketState;
    const message2 = Object.values(s2.messages).at(-1);

    expect(s2.agentId).not.toEqual(agentId);
    expect(s2.resolvedById).toBeDefined();
    expect(s2.closedById).toBeDefined();
    expect(s2.closeAfter).toBeDefined();
    expect(s2.escalateAfter).toBeDefined();
    expect(s2.reassignAfter).toBeDefined();
    expect(message2?.wasDelivered).toBe(true);
    expect(message2?.wasRead).toBe(true);

    // log stream just for fun
    // const events: CommittedEvent[] = [];
    // await app.query({ limit: 10 }, (e) => events.push(e));
    // console.table(events);
  });
});
