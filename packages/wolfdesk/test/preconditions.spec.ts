import { sandbox } from "@rotorsoft/act/test";
import { Chance } from "chance";
import { builder, tenantCorrelator } from "../src/bootstrap.js";
import { type Actions, makeActions, target } from "./actions.js";

const chance = new Chance();

describe("ticket preconditions", () => {
  // Per-suite isolated Act (fresh InMemoryStore + InMemoryCache) built from
  // the shared wolfdesk builder — no singleton port, auto disposed below.
  let dispose: () => Promise<void>;
  let app: Parameters<typeof makeActions>[0];
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
    dispose = ctx.dispose;
    app = ctx.app;
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
    } = makeActions(ctx.app));
  });

  afterAll(async () => {
    await dispose();
  });

  it("should throw when trying to open twice", async () => {
    const t = target();
    await openTicket(t, "opening once", "the first opening");
    await expect(
      openTicket(t, "opening twice", "the second opening")
    ).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      description: "Cannot open twice",
    });
  });

  it("should throw when trying to close twice or empty", async () => {
    const t = target();
    await expect(closeTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(closeTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("should throw when assigning agent to empty or closed ticket", async () => {
    const t = target();
    await expect(assignTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(assignTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("should throw when adding message to empty or closed ticket", async () => {
    const t = target();
    await expect(addMessage(t, "message")).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(addMessage(t, "message")).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("should throw when requesting escalation to empty or closed ticket", async () => {
    const t = target();
    await expect(requestTicketEscalation(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(requestTicketEscalation(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("should throw when escalating empty or closed ticket", async () => {
    const t = target();
    await expect(escalateTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(escalateTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("should throw when reassigning empty or closed ticket", async () => {
    const t = target();
    await expect(reassignTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(reassignTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("should throw when marking messages delivered on empty or closed or invalid ticket", async () => {
    const t = target();
    await expect(markMessageDelivered(t, chance.guid())).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await expect(markMessageDelivered(t, chance.guid())).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      message: "MarkMessageDelivered failed precondition: Message must exist",
    });
    await closeTicket(t);
    await expect(markMessageDelivered(t, chance.guid())).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("should throw when marking message read on empty or closed or invalid ticket", async () => {
    const t = target();
    await expect(acknowledgeMessage(t, chance.guid())).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await expect(acknowledgeMessage(t, chance.guid())).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      message: "AcknowledgeMessage failed precondition: Message must exist",
    });
    await closeTicket(t);
    await expect(acknowledgeMessage(t, chance.guid())).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });

  it("refuses an ack from anyone but the receiver, as a precondition", async () => {
    const t = target();
    await openTicket(t, "ack test", "only the receiver acks");
    const [added] = await addMessage(t, "hello"); // sent to someone else
    const { messageId } = added.event!.data as { messageId: string };
    await expect(acknowledgeMessage(t, messageId)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      message:
        "AcknowledgeMessage failed precondition: Must be receiver to ack",
    });
  });

  it("refuses an escalation before its due date, and a second escalation", async () => {
    const t = target();
    await openTicket(t, "escalation", "not yet");
    await assignTicket(t); // escalateAfter one day out
    await expect(requestTicketEscalation(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      description: "Cannot escalate before due date",
    });
    await escalateTicket(t);
    await expect(escalateTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      description: "Cannot escalate more than once",
    });
  });

  it("refuses a reassignment without escalation, and before its due date", async () => {
    const t = target();
    await openTicket(t, "reassignment", "not yet");
    await expect(reassignTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      description: "Cannot reassign without escalation",
    });
    await assignTicket(t); // reassignAfter one day out
    await escalateTicket(t);
    await expect(reassignTicket(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      description: "Cannot reassign before due date",
    });
  });

  it("refuses a reassignment after the agent acknowledged the customer", async () => {
    const t = target();
    const agent = chance.guid();
    // The app's own reactions (auto-assign, delivery) commit to the same
    // stream, so wait for each before the next action.
    const ticket = async () => (await app.load("Ticket", t.stream)).state;
    await openTicket(t, "acknowledged", "the agent read it");
    await vi.waitFor(async () =>
      expect((await ticket()).agentId).toBeDefined()
    );
    await assignTicket(t, agent, new Date(), new Date());
    const [added] = await addMessage(t, "please help", agent);
    const { messageId } = added.event!.data as { messageId: string };
    await vi.waitFor(async () =>
      expect((await ticket()).messages[messageId]?.wasDelivered).toBe(true)
    );
    await acknowledgeMessage(target(agent, t.stream), messageId);
    await requestTicketEscalation(t);
    await escalateTicket(t);
    await expect(
      reassignTicket(t, chance.guid(), new Date(), new Date())
    ).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      description: "Cannot reassign after agent acknowledged",
    });
  });

  it("should throw when resolving empty or closed ticket", async () => {
    const t = target();
    await expect(markTicketResolved(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(markTicketResolved(t)).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
    });
  });
});
