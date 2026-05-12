// ACT-503: prove the `sandbox` test helper works against a real PG store
// by passing a custom store factory that mints a per-test schema.
import { act, state } from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { z } from "zod";
import { PostgresStore } from "../src/index.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

const actor = { id: "a", name: "a" };

let schemaCounter = 0;
const nextSchema = () => `sandbox_t${++schemaCounter}_${process.pid}`;

describe("sandbox with PostgresStore (factory API)", () => {
  it("builds an Act on a fresh PG schema and tears it down", async () => {
    const schema = nextSchema();
    const { app, store, dispose } = await sandbox(act().withState(Counter), {
      store: () => new PostgresStore({ port: 5431, schema, table: "events" }),
    });

    expect(store).toBeInstanceOf(PostgresStore);

    await app.do("increment", { stream: "c-1", actor }, { by: 7 });
    const snap = await app.load("Counter", "c-1");
    expect(snap.state.count).toBe(7);

    await dispose();
  });

  it("two concurrent sandboxes use isolated PG schemas — no cross-talk", async () => {
    const a = await sandbox(act().withState(Counter), {
      store: () =>
        new PostgresStore({
          port: 5431,
          schema: nextSchema(),
          table: "events",
        }),
    });
    const b = await sandbox(act().withState(Counter), {
      store: () =>
        new PostgresStore({
          port: 5431,
          schema: nextSchema(),
          table: "events",
        }),
    });

    await a.app.do("increment", { stream: "x", actor }, { by: 10 });
    await b.app.do("increment", { stream: "x", actor }, { by: 3 });

    expect((await a.app.load("Counter", "x")).state.count).toBe(10);
    expect((await b.app.load("Counter", "x")).state.count).toBe(3);

    await a.dispose();
    await b.dispose();
  });
});
