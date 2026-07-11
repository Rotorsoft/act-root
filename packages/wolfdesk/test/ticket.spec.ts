import { sandbox } from "@rotorsoft/act/test";
import { Chance } from "chance";
import { builder, tenantCorrelator } from "../src/bootstrap.js";
import { type Actions, makeActions, target } from "./actions.js";

const chance = new Chance();

describe("ticket without reactions", () => {
  // Per-suite isolated Act built from the shared wolfdesk builder.
  let app: ReturnType<typeof builder.build>;
  let dispose: () => Promise<void>;
  let acknowledgeMessage: Actions["acknowledgeMessage"];
  let addMessage: Actions["addMessage"];
  let assignTicket: Actions["assignTicket"];
  let closeTicket: Actions["closeTicket"];
  let escalateTicket: Actions["escalateTicket"];
  let markMessageDelivered: Actions["markMessageDelivered"];
  let markTicketResolved: Actions["markTicketResolved"];
  let openTicket: Actions["openTicket"];
  let reassignTicket: Actions["reassignTicket"];
  let requestTicketEscalation: Actions["requestTicketEscalation"];

  beforeAll(async () => {
    const ctx = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator },
    });
    app = ctx.app;
    dispose = ctx.dispose;
    ({
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
    } = makeActions(app));
  });

  afterAll(async () => {
    await dispose();
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
    messageId = message!.messageId;

    await requestTicketEscalation(t);
    await escalateTicket(t);

    const snapshot = await app.load("Ticket", t.stream);
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

    const snapshot2 = await app.load("Ticket", t.stream);
    const s2 = snapshot2.state;
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
