import { dispose } from "@rotorsoft/act";
import { app } from "../../src/wolfdesk/bootstrap";
import { Ticket } from "../../src/wolfdesk/ticket";
import {
  addMessage,
  openTicket,
  requestTicketEscalation,
  target,
} from "./actions";

describe("reactions", () => {
  afterAll(async () => {
    await dispose()();
  });

  it("should assign agent to new ticket", async () => {
    const t = target();
    await openTicket(t, "assign agent", "Hello");
    await app.drain();

    const snapshot = await app.load(Ticket, t.stream);
    expect(snapshot.state.agentId).toBeDefined();
  });

  it("should deliver new ticket", async () => {
    const t = target();
    await openTicket(t, "deliver", "Hello");
    await addMessage(t, "the body");
    await app.drain();

    const snapshot = await app.load(Ticket, t.stream);
    expect(
      Object.values(snapshot.state.messages).at(-1)?.wasDelivered
    ).toBeDefined();
  });

  it("should request escalation", async () => {
    const t = target();
    await openTicket(t, "request escalation", "Hello");
    await requestTicketEscalation(t);
    await app.drain();

    const snapshot = await app.load(Ticket, t.stream);
    expect(snapshot.state.escalationId).toBeDefined();
  });
});
