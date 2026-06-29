/**
 * Online autoclose (#1090) — `PostgresStore` integration. Autoclose is now a
 * synthesized reaction that defers/closes via the persisted-defer + close
 * mechanic (the unit behavior is covered against InMemory in
 * `libs/act/test/autoclose-reaction.spec.ts`); this file proves the end-to-end
 * shape works against a real Postgres backend — `query_stats` + `truncate` +
 * the `run_close_cycle` pipeline combine the same way, driven by
 * `correlate()` + `drain()` instead of a bespoke sweep.
 */
import {
  act,
  cache,
  dispose,
  state,
  store,
  TOMBSTONE_EVENT,
  ZodEmpty,
} from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_autoclose";

const Ticket = state({ Ticket: z.object({ open: z.boolean() }) })
  .init(() => ({ open: false }))
  .emits({
    TicketOpened: z.object({ title: z.string() }),
    TicketResolved: ZodEmpty,
  })
  .patch({
    TicketOpened: () => ({ open: true }),
    TicketResolved: () => ({ open: false }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
  .emit((a) => ["TicketOpened", { title: a.title }])
  .on({ ResolveTicket: ZodEmpty })
  .emit(() => ["TicketResolved", {}])
  // Close immediately once the terminal event is the head (no cooldown).
  .autocloses({ is: "TicketResolved" })
  .build();

const actor = { id: "pg-test", name: "pg-test" };

describe("PostgresStore — online autoclose integration", () => {
  beforeAll(async () => {
    store(new PostgresStore({ port: PORT, schema: SCHEMA, table: "events" }));
    await store().drop();
    await store().seed();
  });

  beforeEach(async () => {
    await store().drop();
    await store().seed();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("truncates predicate-eligible streams against a Postgres backend", async () => {
    const app = act().withState(Ticket).build();
    const closed: Array<{ truncated: Map<string, unknown> }> = [];
    app.on("closed", (r) =>
      closed.push(r as { truncated: Map<string, unknown> })
    );

    await app.do("OpenTicket", { stream: "t-pg-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-pg-1", actor }, {});

    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("t-pg-1")).toBe(true);
  });

  it("leaves predicate-ineligible streams intact (head event is not the terminal one)", async () => {
    const app = act().withState(Ticket).build();
    const closed: Array<{ truncated: Map<string, unknown> }> = [];
    app.on("closed", (r) =>
      closed.push(r as { truncated: Map<string, unknown> })
    );

    await app.do("OpenTicket", { stream: "t-pg-2", actor }, { title: "a" });

    await app.correlate();
    await app.drain();

    expect(closed.some((r) => r.truncated.has("t-pg-2"))).toBe(false);
  });

  it("leaves a tombstone behind in the events table after truncate", async () => {
    const app = act().withState(Ticket).build();
    await app.do("OpenTicket", { stream: "t-pg-3", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-pg-3", actor }, {});

    await app.correlate();
    await app.drain();

    // Tombstone marker remains; original events are deleted.
    const surviving: string[] = [];
    await store().query((e) => surviving.push(String(e.name)), {
      stream: "t-pg-3",
      stream_exact: true,
    });
    expect(surviving).toEqual([TOMBSTONE_EVENT]);
  });
});
