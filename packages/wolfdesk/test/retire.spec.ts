import { sandbox } from "@rotorsoft/act/test";
import { Chance } from "chance";
import { builder, tenantCorrelator } from "../src/bootstrap.js";
import { Priority } from "../src/schemas/index.js";
import { Agent, agentStream } from "../src/ticket.js";
import { makeActions, target } from "./actions.js";

// Escalating fires the webhook slice, which captures `fetch` as it loads, and
// has no receiver here.
vi.hoisted(() => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
});

const chance = new Chance();
const HOUR = 3_600_000;

describe("retiring tickets", () => {
  it("leaves an open ticket alone after a year, so its agent's count stays true", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, dispose } = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator, autoSettle: false },
    });
    try {
      const actions = makeActions(app);
      const agent = chance.guid();
      const t = target();
      const pump = async () => {
        for (let i = 0; i < 4; i++) {
          await app.correlate();
          await app.drain({ leaseMillis: 1 });
        }
      };
      await app.do("OpenTicket", t, {
        productId: chance.guid(),
        supportCategoryId: chance.guid(),
        priority: Priority.Low,
        title: "a ticket",
        message: "help",
      });
      const soon = new Date(Date.now() + HOUR);
      await actions.assignTicket(t, agent, soon, soon);
      const [m] = await actions.addMessage(t, "hello", agent);
      await pump();
      await actions.acknowledgeMessage(
        { stream: t.stream, actor: { id: agent, name: "agent" } },
        (m.event!.data as { messageId: string }).messageId
      );
      vi.setSystemTime(Date.now() + 366 * 24 * HOUR);
      await actions.openTicket(target(), "another", "traffic");
      await pump();

      const tail = await app.query_array({
        stream: t.stream,
        stream_exact: true,
      });
      expect(tail.at(-1)?.name).not.toBe("__tombstone__");
      const { state } = await app.load(Agent, agentStream(agent));
      expect(state.open).toBe(1);
    } finally {
      vi.useRealTimers();
      await dispose();
    }
  });
});
