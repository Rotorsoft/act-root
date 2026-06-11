/**
 * Online close-the-books (#837 / epic #802) — `SqliteStore`
 * adapter-specific integration. The cycle's logic is unit-tested
 * against the InMemory store in `libs/act/test/`; this file proves
 * the end-to-end shape works against a real SQLite (libSQL)
 * backend. The autoclose primitive does NOT add a new `Store`
 * contract — it composes the existing `query_stats` + `truncate` +
 * `run_close_cycle` pipeline.
 */
import { unlinkSync } from "node:fs";
import { join } from "node:path";
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
import { SqliteStore } from "../src/index.js";

const DB_PATH = join(import.meta.dirname, "test-autoclose.db");

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

const actor = { id: "sqlite-test", name: "sqlite-test" };

describe("SqliteStore — online autoclose integration", () => {
  beforeAll(async () => {
    try {
      unlinkSync(DB_PATH);
    } catch {}
    store(new SqliteStore({ url: `file:${DB_PATH}` }));
    await store().seed();
  });

  beforeEach(async () => {
    await store().drop();
    await store().seed();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()("EXIT").catch(() => {});
    try {
      unlinkSync(DB_PATH);
    } catch {}
  });

  it("truncates predicate-eligible streams against a SQLite backend", async () => {
    const app = act().withState(Ticket).build();
    await app.do("OpenTicket", { stream: "t-sq-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-sq-1", actor }, {});

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

    expect(result.close_result.truncated.has("t-sq-1")).toBe(true);
    expect(closed_events).toHaveLength(1);
    expect(closed_events[0].truncated.has("t-sq-1")).toBe(true);
  });

  it("leaves predicate-ineligible streams intact (head event is not the terminal one)", async () => {
    const app = act().withState(Ticket).build();
    await app.do("OpenTicket", { stream: "t-sq-2", actor }, { title: "a" });

    const controller = (
      app as unknown as {
        _autoclose: { run_once: () => Promise<unknown> };
      }
    )._autoclose;
    const result = (await controller.run_once()) as {
      close_result: { truncated: Map<string, unknown> };
    };

    expect(result.close_result.truncated.has("t-sq-2")).toBe(false);
  });

  it("leaves a tombstone behind in the events table after truncate", async () => {
    const app = act().withState(Ticket).build();
    await app.do("OpenTicket", { stream: "t-sq-3", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-sq-3", actor }, {});

    const controller = (
      app as unknown as {
        _autoclose: { run_once: () => Promise<unknown> };
      }
    )._autoclose;
    await controller.run_once();

    const surviving: string[] = [];
    await store().query((e) => surviving.push(String(e.name)), {
      stream: "t-sq-3",
      stream_exact: true,
    });
    expect(surviving).toEqual([TOMBSTONE_EVENT]);
  });
});
