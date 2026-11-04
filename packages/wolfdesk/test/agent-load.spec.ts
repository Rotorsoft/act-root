import {
  ConcurrencyError,
  PreconditionError,
  ValidationError,
} from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { Chance } from "chance";
import { builder, tenantCorrelator } from "../src/bootstrap.js";
import { AgentLoad, agentStream, MAX_OPEN_TICKETS } from "../src/ticket.js";
import { type Actions, makeActions, target } from "./actions.js";

const chance = new Chance();

describe("open tickets per agent", () => {
  let app: ReturnType<typeof builder.build>;
  let dispose: () => Promise<void>;
  let actions: Actions;

  beforeAll(async () => {
    const ctx = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator, autoSettle: false },
    });
    app = ctx.app;
    dispose = ctx.dispose;
    actions = makeActions(app);
  });

  afterAll(async () => {
    await dispose();
  });

  const open = async () => {
    const t = target();
    await actions.openTicket(t, "a ticket", "help");
    return t;
  };
  const assigned = async (agent: string) => {
    const t = await open();
    await actions.assignTicket(t, agent);
    return t;
  };
  const load = async (agent: string) =>
    (await app.load(AgentLoad, agentStream(agent))).state.open;

  it("an agent takes tickets up to the limit, and the next is refused, storing nothing", async () => {
    const agent = chance.guid();
    for (let i = 0; i < MAX_OPEN_TICKETS; i++) await assigned(agent);
    expect(await load(agent)).toBe(MAX_OPEN_TICKETS);

    const t = await open();
    await expect(actions.assignTicket(t, agent)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect((await app.load("Ticket", t.stream)).state.agentId).toBeUndefined();
    expect(await load(agent)).toBe(MAX_OPEN_TICKETS);
  });

  it("closing a ticket frees its agent's slot", async () => {
    const agent = chance.guid();
    const t = await assigned(agent);
    expect(await load(agent)).toBe(1);
    await actions.closeTicket(t);
    expect(await load(agent)).toBe(0);
  });

  it("closing a ticket with no agent touches no agent", async () => {
    const t = await open();
    await actions.closeTicket(t);
    const events: string[] = [];
    await app.query({ stream: agentStream(), stream_exact: true }, (e) =>
      events.push(e.name as string)
    );
    expect(events).toEqual([]);
    expect((await app.load("Ticket", t.stream)).state.closedById).toBeDefined();
  });

  it("assigning again moves the ticket to the new agent", async () => {
    const [first, second] = [chance.guid(), chance.guid()];
    const t = await assigned(first);
    await actions.assignTicket(t, second);
    expect(await load(first)).toBe(0);
    expect(await load(second)).toBe(1);
    expect((await app.load("Ticket", t.stream)).state.agentId).toBe(second);
  });

  it("a reassign moves the ticket between two agents in one commit", async () => {
    const [first, second] = [chance.guid(), chance.guid()];
    const t = await open();
    await actions.assignTicket(t, first, new Date(), new Date());
    await actions.escalateTicket(t);
    await actions.reassignTicket(t, second);
    expect(await load(first)).toBe(0);
    expect(await load(second)).toBe(1);
  });

  it("a reassign to a full agent leaves the first agent holding the ticket", async () => {
    const [first, full] = [chance.guid(), chance.guid()];
    for (let i = 0; i < MAX_OPEN_TICKETS; i++) await assigned(full);
    const t = await open();
    await actions.assignTicket(t, first, new Date(), new Date());
    await actions.escalateTicket(t);
    await expect(actions.reassignTicket(t, full)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(await load(first)).toBe(1);
    expect(await load(full)).toBe(MAX_OPEN_TICKETS);
    expect((await app.load("Ticket", t.stream)).state.agentId).toBe(first);
  });

  it("assigning to the agent it already has is a refusal", async () => {
    const agent = chance.guid();
    const t = await assigned(agent);
    await expect(actions.assignTicket(t, agent)).rejects.toBeInstanceOf(
      PreconditionError
    );
    expect(await load(agent)).toBe(1);
  });

  it("racing for an agent's last slot: one ticket wins, the other is refused", async () => {
    const agent = chance.guid();
    for (let i = 0; i < MAX_OPEN_TICKETS - 1; i++) await assigned(agent);
    const [a, b] = [await open(), await open()];
    const results = await Promise.allSettled([
      actions.assignTicket(a, agent),
      actions.assignTicket(b, agent),
    ]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).not.toBeInstanceOf(ConcurrencyError);
    expect(refused[0].reason).toBeInstanceOf(ValidationError);
    expect(await load(agent)).toBe(MAX_OPEN_TICKETS);
  });
});
