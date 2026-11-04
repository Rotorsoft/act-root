import { sandbox } from "@rotorsoft/act/test";
import { Chance } from "chance";
import { builder, tenantCorrelator } from "../src/bootstrap.js";
import { assignAgent, reassignAgent } from "../src/services/agent.js";
import { Agent, agentStream, MAX_OPEN_TICKETS } from "../src/ticket.js";
import { makeActions, target } from "./actions.js";

// Escalating fires the webhook slice, which captures `fetch` as it loads, and
// has no receiver here.
vi.hoisted(() => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
});

vi.mock("../src/services/agent.js", async (original) => ({
  ...(await original<typeof import("../src/services/agent.js")>()),
  assignAgent: vi.fn(),
  reassignAgent: vi.fn(),
}));

const chance = new Chance();

describe("the assign reaction with a full agent", () => {
  it("fails, and its retry asks for another agent", async () => {
    const { app, store, dispose } = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator, autoSettle: false },
    });
    const [full, free] = [chance.guid(), chance.guid()];
    const hour = new Date(Date.now() + 3_600_000);
    const agent = (agentId: string) => ({
      agentId,
      escalateAfter: hour,
      reassignAfter: hour,
    });
    await store.commit(
      [
        {
          stream: agentStream(full),
          msgs: Array.from({ length: MAX_OPEN_TICKETS }, () => ({
            name: "TicketTaken",
            data: {},
          })),
        },
      ],
      { correlation: "seed", causation: {} }
    );
    vi.mocked(assignAgent)
      .mockResolvedValue(agent(free))
      .mockResolvedValueOnce(agent(full));

    const t = target();
    await makeActions(app).openTicket(t, "new", "help");
    // A failed reaction waits 10 seconds before its retry.
    vi.useFakeTimers({ toFake: ["Date"] });
    await app.correlate();
    await app.drain({ leaseMillis: 1 });
    expect((await app.load("Ticket", t.stream)).state.agentId).toBeUndefined();
    vi.setSystemTime(Date.now() + 11_000);
    await app.drain({ leaseMillis: 1 });
    vi.useRealTimers();

    expect(vi.mocked(assignAgent)).toHaveBeenCalledTimes(2);
    expect((await app.load("Ticket", t.stream)).state.agentId).toBe(free);
    expect((await app.load(Agent, agentStream(full))).state.open).toBe(
      MAX_OPEN_TICKETS
    );
    expect((await app.load(Agent, agentStream(free))).state.open).toBe(1);
    await dispose();
  });

  it("assigns nothing to a ticket resolved before the reaction ran", async () => {
    const { app, dispose } = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator, autoSettle: false },
    });
    const { openTicket, markTicketResolved } = makeActions(app);
    vi.mocked(assignAgent).mockClear();

    const t = target();
    await openTicket(t, "new", "help");
    await markTicketResolved(t);
    await app.correlate();
    await app.drain({ leaseMillis: 1 });

    expect(vi.mocked(assignAgent)).not.toHaveBeenCalled();
    expect((await app.load("Ticket", t.stream)).state.agentId).toBeUndefined();
    expect(await app.blocked_streams()).toEqual([]);
    await dispose();
  });

  it("stops the reassign timer on a resolved ticket", async () => {
    const { app, dispose } = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator, autoSettle: false },
    });
    const actions = makeActions(app);
    const agent = chance.guid();
    const past = new Date(Date.now() - 1_000);
    vi.mocked(assignAgent).mockResolvedValue({
      agentId: agent,
      escalateAfter: new Date(Date.now() + 3_600_000),
      reassignAfter: past,
    });

    const t = target();
    await actions.openTicket(t, "new", "help");
    await actions.assignTicket(t, agent, past, past);
    await actions.escalateTicket(t);
    await actions.markTicketResolved(t);
    for (let i = 0; i < 3; i++) {
      await app.correlate();
      await app.drain({ leaseMillis: 1 });
    }

    expect(vi.mocked(reassignAgent)).not.toHaveBeenCalled();
    expect((await app.load("Ticket", t.stream)).state.agentId).toBe(agent);
    expect(await app.blocked_streams()).toEqual([]);
    await dispose();
  });
});
