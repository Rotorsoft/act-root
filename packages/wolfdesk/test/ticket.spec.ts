import { dispose } from "@rotorsoft/act";
import { Chance } from "chance";
import { app } from "../src/bootstrap.js";
import { Ticket } from "../src/ticket.js";
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
    expect(snapshot.state.title).toEqual(title);
    expect(snapshot.state.agentId).toBeDefined();
    expect(Object.keys(snapshot.state.messages).length).toBe(2);
    expect(snapshot.patches).toBeGreaterThanOrEqual(5);
  });

  it("should reassign, mark message delivered, acknowledge, and resolve", async () => {
    await reassignTicket(t);
    await markMessageDelivered(t, messageId);
    await acknowledgeMessage(target(to, t.stream), messageId);
    await markTicketResolved(t);
    await closeTicket(t);

    const snapshot2 = await app.load(Ticket, t.stream);
    const message2 = Object.values(snapshot2.state.messages).at(-1);

    expect(snapshot2.state.agentId).not.toEqual(agentId);
    expect(snapshot2.state.resolvedById).toBeDefined();
    expect(snapshot2.state.closedById).toBeDefined();
    expect(snapshot2.state.closeAfter).toBeDefined();
    expect(snapshot2.state.escalateAfter).toBeDefined();
    expect(snapshot2.state.reassignAfter).toBeDefined();
    expect(message2?.wasDelivered).toBe(true);
    expect(message2?.wasRead).toBe(true);

    // log stream just for fun
    // const events: CommittedEvent[] = [];
    // await app.query({ limit: 10 }, (e) => events.push(e));
    // console.table(events);
  });
});
