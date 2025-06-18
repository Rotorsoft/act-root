import { dispose } from "@rotorsoft/act";
import { Chance } from "chance";
import { eq } from "drizzle-orm";
import { db, init_tickets_db, tickets } from "../../src/drizzle";
import { app } from "../../src/wolfdesk/bootstrap";
import { AutoClose, AutoEscalate, AutoReassign } from "../../src/wolfdesk/jobs";
import { Priority } from "../../src/wolfdesk/schemas";
import { Ticket } from "../../src/wolfdesk/ticket";
import {
  addMessage,
  assignTicket,
  closeTicket,
  escalateTicket,
  markTicketResolved,
  openTicket,
  reassignTicket,
  target,
} from "./actions";

const chance = new Chance();

describe("ticket projection", () => {
  beforeAll(async () => {
    await init_tickets_db();
    await db.delete(tickets);
    // act.on("drained", (value) =>
    //   console.log(
    //     `drained ${value.stream.stream} ${value.first}:${value.last} @ ${value.stream.position}`
    //   )
    // );
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should project tickets", async () => {
    const t = target();
    const title = "projecting";
    const message = "openting a new ticket for projection";

    await openTicket(t, title, message);
    await addMessage(t, "first message");
    await app.drain();

    await escalateTicket(t);
    await app.drain();

    await reassignTicket(t);
    await markTicketResolved(t);
    await closeTicket(t);
    await app.drain();

    const state = (
      await db.select().from(tickets).where(eq(tickets.id, t.stream)).limit(1)
    ).at(0);
    expect(state?.id).toBe(t.stream);
    expect(state?.userId).toBeDefined();
    expect(state?.agentId).toBeDefined();
    expect(state?.title).toBe(title);
    expect(state?.messages).toBe(1);
    expect(state?.closedById).toBeDefined();
    expect(state?.resolvedById).toBeDefined();
    expect(state?.escalationId).toBeDefined();
    expect(state?.closeAfter).toBeDefined();
    expect(state?.escalateAfter).toBeDefined();
    expect(state?.reassignAfter).toBeDefined();
    // just to check projection while preparing test
    // console.table(state);
  });

  describe("automations", () => {
    it("should escalate ticket", async () => {
      const t = target();

      await openTicket(t, "auto escalate", "Hello");
      await assignTicket(t, chance.guid(), new Date(), new Date());
      await app.drain();

      await AutoEscalate(1).catch(console.error);
      await app.drain();

      const snapshot = await app.load(Ticket, t.stream);
      expect(snapshot.state.escalationId).toBeDefined();
    });

    it("should close ticket", async () => {
      const t = target();

      await openTicket(
        t,
        "auto close me",
        "Hello",
        chance.guid(),
        chance.guid(),
        Priority.High,
        new Date()
      );
      await app.drain();

      await AutoClose(1).catch(console.error);
      await app.drain();

      const snapshot = await app.load(Ticket, t.stream);
      expect(snapshot.state.closedById).toBeDefined();
    });

    it("should reassign ticket", async () => {
      const now = new Date();
      const t = target();
      const agentId = chance.guid();

      await openTicket(t, "auto re-assign me", "Hello");
      await assignTicket(t, agentId, now, now);
      await app.drain();

      await escalateTicket(t);
      await app.drain();

      await AutoReassign(1).catch(console.error);
      await app.drain();

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
});
