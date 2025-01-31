import { dispose } from "@rotorsoft/act";
import { act, connect } from "../../src/wolfdesk/app";
import { Ticket } from "../../src/wolfdesk/ticket";
import {
  addMessage,
  openTicket,
  requestTicketEscalation,
  target,
} from "./actions";

describe("reactions", () => {
  const broker = connect();

  afterAll(async () => {
    await dispose()();
  });

  it("should assign agent to new ticket", async () => {
    const t = target();
    await openTicket(t, "assign agent", "Hello");
    await broker.drain();

    const snapshot = await act.load(Ticket, t.stream);
    expect(snapshot.state.agentId).toBeDefined();
  });

  it("should deliver new ticket", async () => {
    const t = target();
    await openTicket(t, "deliver", "Hello");
    await addMessage(t, "the body");
    await broker.drain();

    const snapshot = await act.load(Ticket, t.stream);
    expect(
      Object.values(snapshot.state.messages).at(-1)?.wasDelivered
    ).toBeDefined();
  });

  it("should request escalation", async () => {
    const t = target();
    await openTicket(t, "request escalation", "Hello");
    await requestTicketEscalation(t);
    await broker.drain();

    const snapshot = await act.load(Ticket, t.stream);
    expect(snapshot.state.escalationId).toBeDefined();
  });
});
