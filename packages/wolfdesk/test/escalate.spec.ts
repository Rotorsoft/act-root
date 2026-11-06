import { sandbox } from "@rotorsoft/act/test";
import { Chance } from "chance";
import { builder, tenantCorrelator } from "../src/bootstrap.js";
import { makeActions, target } from "./actions.js";

// Escalating fires the webhook slice, which captures `fetch` as it loads.
const posts = vi.hoisted(() => {
  const posts: string[] = [];
  globalThis.fetch = async (url) => {
    posts.push(String(url));
    return new Response(null, { status: 200 });
  };
  return posts;
});

const chance = new Chance();

describe("auto escalation", () => {
  it("leaves a resolved ticket alone", async () => {
    const { app, dispose } = await sandbox(builder, {
      actOptions: { correlator: tenantCorrelator, autoSettle: false },
    });
    const run = async () => {
      for (let i = 0; i < 6; i++) {
        await app.correlate({ limit: 1000 });
        await app.drain({ streamLimit: 300, eventLimit: 300, leaseMillis: 1 });
      }
    };
    const actions = makeActions(app);
    const t = target();
    await actions.openTicket(t, "resolve me", "help");
    await run();
    await actions.assignTicket(
      t,
      chance.guid(),
      new Date(Date.now() + 40),
      new Date(Date.now() + 3_600_000)
    );
    await run();
    await actions.markTicketResolved(t);
    await run();
    await new Promise((r) => setTimeout(r, 80));
    await run();
    const { state } = await app.load("Ticket", t.stream);
    expect(state.resolvedById).toBeTruthy();
    expect(state.escalationId).toBeUndefined();
    expect(posts).toEqual([]);
    await dispose();
  }, 30_000);
});
