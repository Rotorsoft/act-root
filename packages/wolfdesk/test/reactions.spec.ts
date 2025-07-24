import { dispose } from "@rotorsoft/act";
import { app } from "../src/bootstrap.js";
import { db, init_tickets_db, tickets } from "../src/drizzle/index.js";
import { Ticket } from "../src/ticket.js";
import {
  addMessage,
  openTicket,
  requestTicketEscalation,
  target,
} from "./actions.js";

describe("reactions", () => {
  afterAll(async () => {
    await init_tickets_db();
    await db.delete(tickets).catch((e) => console.error(e));
    await dispose()();
  });

  it("should assign agent to new ticket", async () => {
    const t = target(undefined, "should assign agent");
    await openTicket(t, "assign agent", "Hello");
    await app.drain();

    const snapshot = await app.load(Ticket, t.stream);
    expect(snapshot.state.agentId).toBeDefined();
  });

  it("should deliver new ticket", async () => {
    const t = target(undefined, "should deliver new ticket");
    await openTicket(t, "deliver", "Hello");
    await addMessage(t, "the body");
    await app.drain();

    const snapshot = await app.load(Ticket, t.stream);
    expect(
      Object.values(snapshot.state.messages).at(-1)?.wasDelivered
    ).toBeDefined();
  });

  it("should request escalation", async () => {
    const t = target(undefined, "should request escalation");
    await openTicket(t, "request escalation", "Hello");
    await requestTicketEscalation(t);
    await app.drain();

    const snapshot = await app.load(Ticket, t.stream);
    expect(snapshot.state.escalationId).toBeDefined();
  });
});
