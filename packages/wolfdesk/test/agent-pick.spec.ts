import { PreconditionError } from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { Chance } from "chance";
import { eq } from "drizzle-orm";
import { builder, tenantCorrelator } from "../src/bootstrap.js";
import { agents, db } from "../src/drizzle/index.js";
import { Agent, agentStream, MAX_OPEN_TICKETS } from "../src/ticket.js";
import { addDesk, makeActions, target } from "./actions.js";

// Escalating fires the webhook slice, which captures `fetch` as it loads, and
// has no receiver here.
vi.hoisted(() => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
});

const chance = new Chance();

describe("picking an agent", { timeout: 30_000 }, () => {
  let app: ReturnType<typeof builder.build>;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator, autoSettle: false },
    });
    app = ctx.app;
    dispose = ctx.dispose;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await dispose();
  });

  const run = async () => {
    for (let i = 0; i < 3; i++) {
      await app.correlate({ limit: 1000 });
      await app.drain({ streamLimit: 200, eventLimit: 200, leaseMillis: 1 });
    }
  };
  // A waiting reaction wakes on its own timer, which a faked clock doesn't
  // reach, so another commit wakes the drain instead.
  const a_minute_later = async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await makeActions(app).openTicket(target(), "another", "help");
    await run();
    vi.useRealTimers();
  };
  const wait = { timeout: 20_000, interval: 50 };
  const agentOf = async (stream: string) =>
    (await app.load("Ticket", stream)).state.agentId;
  const row = async (id: string) =>
    (await db.select().from(agents).where(eq(agents.id, id))).at(0);
  // Fills an agent and waits for the table to show it.
  const fill = async (id: string, category: string) => {
    const { assignTicket, openTicket } = makeActions(app, category);
    const held = [];
    for (let i = 0; i < MAX_OPEN_TICKETS; i++) {
      const t = target();
      await openTicket(t, "held", "help");
      await assignTicket(t, id);
      held.push(t);
    }
    await vi.waitFor(async () => {
      await run();
      expect((await row(id))?.open).toBe(MAX_OPEN_TICKETS);
    }, wait);
    return held;
  };

  it("refuses adding an agent twice", async () => {
    const id = chance.guid();
    const add = () =>
      app.do(
        "AddAgent",
        { stream: agentStream(id), actor: { id, name: "desk" } },
        { name: "Ada", supportCategoryId: chance.guid() }
      );
    await add();
    await expect(add()).rejects.toBeInstanceOf(PreconditionError);
  });

  it("picks the agent with the fewest open tickets in the ticket's category", async () => {
    const { category, ids } = await addDesk(app);
    await addDesk(app); // another category, which must not be picked
    const { assignTicket, openTicket } = makeActions(app, category);
    const [busy, free] = ids;
    const held = target();
    await openTicket(held, "held", "help");
    await assignTicket(held, busy);
    await vi.waitFor(async () => {
      await run();
      expect((await row(busy))?.open).toBe(1);
    }, wait);

    const t = target();
    await openTicket(t, "new", "help");
    await run();
    expect(await agentOf(t.stream)).toBe(free);
    await vi.waitFor(async () => {
      await run();
      expect((await row(free))?.open).toBe(1);
    }, wait);
  });

  it("makes a ticket wait with nobody free, and assigns it when a slot frees", async () => {
    const { category, ids } = await addDesk(app, undefined, 1);
    const [agent] = ids;
    const { closeTicket, openTicket } = makeActions(app, category);
    const held = await fill(agent, category);

    const t = target();
    await openTicket(t, "waiting", "help");
    await run();
    expect(await agentOf(t.stream)).toBeUndefined();
    expect(await app.blocked_streams()).toEqual([]);

    await closeTicket(held[0]);
    await vi.waitFor(async () => {
      await run();
      expect((await row(agent))?.open).toBe(MAX_OPEN_TICKETS - 1);
    }, wait);
    // Still waiting: the reaction looks again in a minute.
    expect(await agentOf(t.stream)).toBeUndefined();

    await a_minute_later();
    expect(await agentOf(t.stream)).toBe(agent);
    expect((await app.load(Agent, agentStream(agent))).state.open).toBe(
      MAX_OPEN_TICKETS
    );
  });

  it("stops waiting once the ticket is closed, or assigned by hand", async () => {
    const { category, ids } = await addDesk(app, undefined, 1);
    const [agent] = ids;
    const { assignTicket, closeTicket, openTicket } = makeActions(
      app,
      category
    );
    await fill(agent, category);

    const [closed, by_hand] = [target(), target()];
    await openTicket(closed, "closed", "help");
    await openTicket(by_hand, "by hand", "help");
    await run();
    await closeTicket(closed);
    const other = chance.guid();
    await assignTicket(by_hand, other);

    await a_minute_later();
    expect(await agentOf(closed.stream)).toBeUndefined();
    expect(await agentOf(by_hand.stream)).toBe(other);
    expect(await app.blocked_streams()).toEqual([]);
  });

  it("reassigns to someone else, and waits when there's nobody else", async () => {
    const { category, ids } = await addDesk(app, undefined, 1);
    const [only] = ids;
    const { assignTicket, escalateTicket, openTicket } = makeActions(
      app,
      category
    );
    const past = new Date(Date.now() - 1_000);
    const t = target();
    await openTicket(t, "stuck", "help");
    await assignTicket(t, only, new Date(Date.now() + 3_600_000), past);
    await escalateTicket(t);
    await run();
    expect(await agentOf(t.stream)).toBe(only);

    const other = chance.guid();
    await app.do(
      "AddAgent",
      { stream: agentStream(other), actor: { id: other, name: "desk" } },
      { name: "Ben", supportCategoryId: category }
    );
    await vi.waitFor(async () => {
      await run();
      expect((await row(other))?.name).toBe("Ben");
    }, wait);
    await a_minute_later();
    expect(await agentOf(t.stream)).toBe(other);
  });
});
