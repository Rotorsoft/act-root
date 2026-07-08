import { cache, dispose } from "@rotorsoft/act";
import { Chance } from "chance";
import { eq } from "drizzle-orm";
import { app } from "../src/bootstrap.js";
import { db, init_tickets_db, tickets } from "../src/drizzle/index.js";
import { Priority } from "../src/schemas/index.js";
import { Ticket } from "../src/ticket-projections.js";
import {
  addMessage,
  assignTicket,
  escalateTicket,
  markTicketResolved,
  openTicket,
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

  const DAY = 24 * 60 * 60 * 1000;
  const future = () => new Date(Date.now() + DAY);
  // A few correlate+drain passes let a defer chain settle (each pass wakes the
  // streams whose due-time has passed and runs the next hop).
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await app.correlate({ limit: 200 });
      await app.drain({ streamLimit: 100, eventLimit: 100, leaseMillis: 50 });
    }
  };

  it("projection", async () => {
    const now = new Date();
    const t = target(chance.guid(), "projecting");
    const title = "projecting";
    const message = "opening a new ticket for projection";

    // Due-now deadlines so the deferred escalate/reassign/close automations all
    // fire and populate every projection column. The manual assign is committed
    // before the first drain, so its escalate defer is the one that fires now.
    await openTicket(
      t,
      title,
      message,
      chance.guid(),
      chance.guid(),
      Priority.Low,
      now
    );
    await assignTicket(t, chance.guid(), now, now);
    await addMessage(t, "first message");
    await markTicketResolved(t);
    await settle();

    const ticket = await findTicket(t.stream);
    expect(ticket?.id).toBe(t.stream);
    expect(ticket?.userId).toBeDefined();
    expect(ticket?.agentId).toBeDefined();
    expect(ticket?.title).toBe(title);
    // Opening a ticket carries its first message (the creation reducer
    // stores it in state.messages), so open + addMessage = 2. The old
    // per-event projection undercounted by starting at 0 and counting
    // only MessageAdded; the fold projects the state as it truly is.
    expect(ticket?.messages).toBe(2);
    expect(ticket?.closedById).toBeDefined();
    expect(ticket?.resolvedById).toBeDefined();
    expect(ticket?.escalationId).toBeDefined();
    expect(ticket?.closeAfter).toBeDefined();
    expect(ticket?.escalateAfter).toBeDefined();
    expect(ticket?.reassignAfter).toBeDefined();

    // The row never lies: columns equal the full-state fold ground truth.
    // Fresh replay through the full artifact is the fold ground truth —
    // invalidate first, since a warm entry written mid-automation-chain
    // can sit at the head frontier without the deferred fields folded in.
    await cache().invalidate(t.stream);
    const truth = await app.load(Ticket, t.stream);
    expect(ticket?.title).toBe(truth.state.title);
    expect(ticket?.messages).toBe(Object.keys(truth.state.messages).length);
    expect(ticket?.agentId).toBe(truth.state.agentId);
    expect(ticket?.escalationId).toBe(truth.state.escalationId);
  });

  // Timing automations are now deferred reactions (src/ticket-timers.ts), not
  // polling jobs. Each test sets a due-now deadline so the reaction fires on the
  // next drain; a few correlate+drain passes let the defer chain settle.
  describe("automations (deferred reactions)", () => {
    it("should escalate ticket at its escalateAfter", async () => {
      const now = new Date();
      const t = target(chance.guid(), "auto escalate");

      // Assign with an immediate escalate deadline (reassign stays in the
      // future). The manual assign is committed before the first drain, so its
      // escalate defer is the first the escalate:<id> target sees and fires now.
      await openTicket(t, "auto escalate", "Hello");
      await assignTicket(t, chance.guid(), now);
      await settle();

      const ticket = await findTicket(t.stream);
      expect(ticket?.agentId).toBeDefined();
      expect(ticket?.escalationId).toBeDefined();

      const snapshot = await app.load("Ticket", t.stream);
      expect(snapshot.state.escalationId).toBeDefined();
    });

    it("should close ticket at its closeAfter", async () => {
      const t = target(chance.guid(), "auto close me");
      const now = new Date();

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

      await settle();

      const ticket = await findTicket(t.stream);
      expect(ticket?.resolvedById).toBeDefined();
      expect(ticket?.closeAfter).toBe(now.getTime());
      expect(ticket?.closedById).toBeDefined();

      const snapshot = await app.load("Ticket", t.stream);
      expect(snapshot.state.closedById).toBeDefined();
    });

    it("should reassign an escalated, unanswered ticket", async () => {
      const now = new Date();
      const t = target(chance.guid(), "auto re-assign me");
      const agentId = chance.guid();

      // Let the assign-on-open reaction assign first (future deadlines), then
      // manually assign LAST with a due-now reassignAfter (a far-future escalate
      // so nothing auto-escalates), so live state carries the due-now deadline.
      await openTicket(t, "auto re-assign me", "Hello");
      await app.correlate({ limit: 200 });
      await app.drain();
      await assignTicket(t, agentId, future(), now);

      // Escalation is the precondition for reassignment; the reassign defer
      // reads reassignAfter from state and fires because it's already due.
      await escalateTicket(t);
      await settle();

      const ticket = await findTicket(t.stream);
      expect(ticket?.agentId).toBeDefined();
      expect(ticket?.agentId).not.toEqual(agentId);
      expect(ticket?.reassignAfter).toBeGreaterThan(now.getTime());

      const snapshot = await app.load("Ticket", t.stream);
      expect(snapshot.state.agentId).toBeDefined();
      expect(snapshot.state.agentId).not.toEqual(agentId);
      expect(snapshot.state.reassignAfter?.getTime()).toBeGreaterThan(
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

      const snapshot = await app.load("Ticket", t.stream);
      expect(snapshot.state.agentId).toBeDefined();
    });

    it("should deliver new ticket", async () => {
      const t = target(undefined, "should deliver new ticket");
      await openTicket(t, "deliver", "Hello");
      await addMessage(t, "the body");
      await app.correlate({ limit: 120 }); // 120 to reach the previous event
      await app.drain();

      const snapshot = await app.load("Ticket", t.stream);
      const lastMsg = Object.values(snapshot.state.messages).at(-1);
      expect(lastMsg?.wasDelivered).toBeDefined();
    });

    it("should request escalation", async () => {
      const t = target(undefined, "should request escalation");
      await openTicket(t, "request escalation", "Hello");
      await requestTicketEscalation(t);
      await app.correlate({ limit: 120 }); // 120 to reach the previous event
      await app.drain();

      const snapshot = await app.load("Ticket", t.stream);
      expect(snapshot.state.escalationId).toBeDefined();
    });
  });
});
