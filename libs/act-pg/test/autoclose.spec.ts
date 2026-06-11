/**
 * Online close-the-books (#837 / epic #802) — `PostgresStore`
 * adapter-specific integration. The cycle's logic lives in
 * `libs/act/src/internal/autoclose-cycle.ts` and is exhaustively
 * unit-tested against the InMemory store; this file proves the
 * end-to-end shape works against a real Postgres backend without
 * adapter-specific surprises (commit / query_stats / truncate
 * combine the same way under `query_stats({}, {count: true})`-then-
 * `truncate(targets)`).
 *
 * The autoclose primitive does NOT add a new `Store` contract — it
 * composes the existing `query_stats` + `truncate` + the
 * `run_close_cycle` pipeline. No TCK extension needed; this file
 * is the integration smoke test.
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
  .autocloses((_stream, head) => head.name === "TicketResolved")
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
    await app.do("OpenTicket", { stream: "t-pg-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-pg-1", actor }, {});

    const controller = (
      app as unknown as {
        _autoclose: { run_once: () => Promise<unknown> };
      }
    )._autoclose;
    const closed_events: Array<{ truncated: Map<string, unknown> }> = [];
    app.on("closed", (r) =>
      closed_events.push(r as { truncated: Map<string, unknown> })
    );

    const result = (await controller.run_once()) as {
      close_result: { truncated: Map<string, unknown> };
    };

    expect(result.close_result.truncated.has("t-pg-1")).toBe(true);
    expect(closed_events).toHaveLength(1);
    expect(closed_events[0].truncated.has("t-pg-1")).toBe(true);
  });

  it("leaves predicate-ineligible streams intact (head event is not the terminal one)", async () => {
    const app = act().withState(Ticket).build();
    await app.do("OpenTicket", { stream: "t-pg-2", actor }, { title: "a" });

    const controller = (
      app as unknown as {
        _autoclose: { run_once: () => Promise<unknown> };
      }
    )._autoclose;
    const result = (await controller.run_once()) as {
      close_result: { truncated: Map<string, unknown> };
    };

    expect(result.close_result.truncated.has("t-pg-2")).toBe(false);
  });

  it("leaves a tombstone behind in the events table after truncate", async () => {
    const app = act().withState(Ticket).build();
    await app.do("OpenTicket", { stream: "t-pg-3", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-pg-3", actor }, {});

    const controller = (
      app as unknown as {
        _autoclose: { run_once: () => Promise<unknown> };
      }
    )._autoclose;
    await controller.run_once();

    // Tombstone marker remains; original events are deleted.
    const surviving: string[] = [];
    await store().query((e) => surviving.push(String(e.name)), {
      stream: "t-pg-3",
      stream_exact: true,
    });
    expect(surviving).toEqual([TOMBSTONE_EVENT]);
  });
});
