/**
 * What the framework does over this store with history a close changed: time
 * travel after a prune or a restart, and `.autocloses` on a stream whose name
 * has a regex metacharacter. Core covers these on InMemory; the differences
 * that matter here are the store's.
 */
import { act, dispose, sleep, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const actor = { id: "a", name: "a" };
const base = () =>
  state({ R: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Hit: ZodEmpty, Done: ZodEmpty })
    .patch({
      Hit: (_, s) => ({ n: s.n + 1 }),
      Done: (_, s) => ({ n: s.n + 1 }),
    })
    .on({ hit: ZodEmpty })
    .emit(() => ["Hit", {}])
    .on({ done: ZodEmpty })
    .emit(() => ["Done", {}]);
const later = () => ({ created_before: new Date(Date.now() + 3_600_000) });

describe("history a close changed", () => {
  beforeAll(async () => {
    store(
      new PostgresStore({
        port: 5431,
        schema: schema("act_history_edges"),
        table: "events",
      })
    );
    await store().drop();
    await store().seed();
  });

  afterAll(async () => {
    await store().drop();
    await dispose()("EXIT").catch(() => {});
  });

  it("time travel keeps what a windowed close moved into a snapshot", async () => {
    const R = base()
      .snap((s) => s.patches >= 2)
      .build();
    const app = act().withState(R).build({ autoSettle: false });
    for (let i = 0; i < 5; i++)
      await app.do("hit", { stream: "pruned", actor }, {});
    await sleep(5);
    await app.close([{ stream: "pruned", before: new Date() }]);
    const { state: past } = await app.load(R, "pruned", undefined, later());
    expect(past.n).toBe(5);
  });

  it("time travel keeps what a restart seeded", async () => {
    const R = base().build();
    const app = act().withState(R).build({ autoSettle: false });
    for (let i = 0; i < 5; i++)
      await app.do("hit", { stream: "restarted", actor }, {});
    await app.close([{ stream: "restarted", restart: true }]);
    await app.do("hit", { stream: "restarted", actor }, {});
    const { state: past } = await app.load(R, "restarted", undefined, later());
    expect(past.n).toBe(6);
  });

  it("autocloses a stream whose name has a regex metacharacter", async () => {
    const R = base().autocloses({ is: "Done" }).build();
    const app = act().withState(R).build({ autoSettle: false });
    await app.do("hit", { stream: "room+a", actor }, {});
    await app.do("done", { stream: "room+a", actor }, {});
    for (let i = 0; i < 3; i++) {
      await app.correlate();
      await app.drain();
    }
    const names = (
      await app.query_array({ stream: "room+a", stream_exact: true })
    ).map((e) => e.name);
    expect(names).toEqual(["__tombstone__"]);
  });
});
