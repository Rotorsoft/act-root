import { dispose } from "@rotorsoft/act";
import { Chance } from "chance";
import { eq } from "drizzle-orm";
import { app } from "../src/bootstrap.js";
import { db, init_tickets_db, tickets } from "../src/drizzle/index.js";
import { AutoClose, AutoEscalate, AutoReassign } from "../src/jobs.js";
import { Priority } from "../src/schemas/index.js";
import { Ticket } from "../src/ticket.js";
import {
  addMessage,
  assignTicket,
  closeTicket,
  escalateTicket,
  markTicketResolved,
  openTicket,
  reassignTicket,
  requestTicketEscalation,
  target,
} from "./actions.js";

const chance = new Chance();

// finds projected ticket by stream
async function findTicket(stream: string) {
  return (
    await db.select().from(tickets).where(eq(tickets.id, stream)).limit(1)
  ).at(0);
}

describe("tickets", () => {
  beforeAll(async () => {
    await init_tickets_db();
    await db.delete(tickets).catch((e) => console.error(e));
    // app.on("acked", (leases) => console.log("acked", leases));
  });

  afterAll(async () => {
    await dispose()();
  });

  it("projection", async () => {
    const t = target(chance.guid(), "projecting");
    const title = "projecting";
    const message = "opening a new ticket for projection";

    await openTicket(t, title, message);
    await addMessage(t, "first message");
    await app.correlate();
    await app.drain();

    await escalateTicket(t);
    await app.correlate();
    await app.drain();

    await reassignTicket(t);
    await markTicketResolved(t);
    await closeTicket(t);
    await app.correlate();
    await app.drain();

    const ticket = await findTicket(t.stream);
    expect(ticket?.id).toBe(t.stream);
    expect(ticket?.userId).toBeDefined();
    expect(ticket?.agentId).toBeDefined();
    expect(ticket?.title).toBe(title);
    expect(ticket?.messages).toBe(1);
    expect(ticket?.closedById).toBeDefined();
    expect(ticket?.resolvedById).toBeDefined();
    expect(ticket?.escalationId).toBeDefined();
    expect(ticket?.closeAfter).toBeDefined();
    expect(ticket?.escalateAfter).toBeDefined();
    expect(ticket?.reassignAfter).toBeDefined();
    // just to check projection while preparing test
    console.table(ticket);
  });

  describe("automations", () => {
    it("should escalate ticket", async () => {
      const now = new Date();
      const t = target(chance.guid(), "auto escalate");

      // open and assign with immediate escalate and reassign dates
      await openTicket(t, "auto escalate", "Hello");
      await assignTicket(t, chance.guid(), now, now);

      // project and verify agent and escalate after
      await app.correlate();
      await app.drain({
        streamLimit: 100,
        eventLimit: 100,
        leaseMillis: 10_000,
      });
      let ticket = await findTicket(t.stream);
      expect(ticket?.agentId).toBeDefined();
      expect(ticket?.escalateAfter).toBe(now.getTime());
      expect(ticket?.reassignAfter).toBe(now.getTime());

      // trigger automation
      await AutoEscalate(1).catch(console.error);

      // project and verify escalation id
      await app.correlate();
      await app.drain({
        streamLimit: 100,
        eventLimit: 100,
        leaseMillis: 10_000,
      });
      ticket = await findTicket(t.stream);
      expect(ticket?.escalationId).toBeDefined();

      // load state and verify escalation id
      const snapshot = await app.load(Ticket, t.stream);
      expect(snapshot.state.escalationId).toBeDefined();
    });

    it("should close ticket", async () => {
      const t = target(chance.guid(), "auto close me");
      const now = new Date();

      // open and resolve with immediate close after date
      await openTicket(
        t,
        "auto close me",
        "Hello",
        chance.guid(),
        chance.guid(),
        Priority.High,
        now
      );
      const [snap] = await markTicketResolved(t);
      expect(snap.state.resolvedById).toBeDefined();

      // project and verify
      await app.correlate();
      const drained = await app.drain();
      expect(drained.acked.length).toBeGreaterThan(0);

      let ticket = await findTicket(t.stream);
      console.table(ticket);
      expect(ticket?.resolvedById).toBeDefined();
      expect(ticket?.closeAfter).toBe(now.getTime());

      // trigger automation
      await AutoClose(1);

      // project and verify closed by
      await app.correlate();
      await app.drain();
      ticket = await findTicket(t.stream);
      expect(ticket?.closedById).toBeDefined();

      // load state and verify closed by
      const snapshot = await app.load(Ticket, t.stream);
      expect(snapshot.state.closedById).toBeDefined();
    });

    it("should reassign ticket", async () => {
      const now = new Date();
      const t = target(chance.guid(), "auto re-assign me");
      const agentId = chance.guid();

      // open and assign with immediate escalate and reassign dates
      await openTicket(t, "auto re-assign me", "Hello");
      await assignTicket(t, agentId, now, now);

      // project and verify agent and escalate after
      await app.correlate({ limit: 120 }); // 120 to reach the previous event
      await app.drain();
      let ticket = await findTicket(t.stream);
      expect(ticket?.agentId).toBeDefined();
      expect(ticket?.escalateAfter).toBe(now.getTime());
      expect(ticket?.reassignAfter).toBe(now.getTime());

      // manually escalate
      await escalateTicket(t);

      // project and verify escalation id
      await app.drain();
      ticket = await findTicket(t.stream);
      expect(ticket?.escalationId).toBeDefined();

      // trigger automation
      await AutoReassign(1);

      // project and verify new agent and reassign after date
      await app.drain();
      ticket = await findTicket(t.stream);
      expect(ticket?.agentId).toBeDefined();
      expect(ticket?.agentId).not.toEqual(agentId);
      expect(ticket?.reassignAfter).toBeGreaterThan(now.getTime());
      expect(ticket?.escalateAfter).toBeGreaterThan(now.getTime());

      // load state and verify new agent and reassign after date
      const snapshot = await app.load(Ticket, t.stream);
      expect(snapshot.state.agentId).toBeDefined();
      expect(snapshot.state.agentId).not.toEqual(agentId);
      expect(snapshot.state.reassignAfter?.getTime()).toBeGreaterThan(
        now.getTime()
      );
      expect(snapshot.state.escalateAfter?.getTime()).toBeGreaterThan(
        now.getTime()
      );
    });
  });

  describe("reactions", () => {
    it("should assign agent to new ticket", async () => {
      const t = target(undefined, "should assign agent");
      await openTicket(t, "assign agent", "Hello");
      await app.correlate({ limit: 120 }); // 120 to reach the previous event
      await app.drain();

      const snapshot = await app.load(Ticket, t.stream);
      expect(snapshot.state.agentId).toBeDefined();
    });

    it("should deliver new ticket", async () => {
      const t = target(undefined, "should deliver new ticket");
      await openTicket(t, "deliver", "Hello");
      await addMessage(t, "the body");
      await app.correlate({ limit: 120 }); // 120 to reach the previous event
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
      await app.correlate({ limit: 120 }); // 120 to reach the previous event
      await app.drain();

      const snapshot = await app.load(Ticket, t.stream);
      expect(snapshot.state.escalationId).toBeDefined();
    });
  });
});
