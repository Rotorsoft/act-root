/**
 * What the framework does over this store with history a close changed: time
 * travel after a prune or a restart, and `.autocloses` beside a stream whose
 * name has a regex metacharacter. Core covers these on InMemory; the differences
 * that matter here are the store's.
 */
import { act, dispose, sleep, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { SqliteStore } from "../src/index.js";
import { rm_tmp_dbs, tmp_db_url } from "./tmp-db.js";

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
    store(new SqliteStore({ url: tmp_db_url() }));
    await store().drop();
    await store().seed();
  });

  afterAll(async () => {
    await store().drop();
    await dispose()("EXIT").catch(() => {});
    rm_tmp_dbs();
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

  it("a stream whose name reads as a pattern doesn't stop the others", async () => {
    const R = base().autocloses({ is: "Done" }).build();
    const app = act().withState(R).build({ autoSettle: false });
    for (const stream of ["^room-a", "room-b"]) {
      await app.do("hit", { stream, actor }, {});
      await app.do("done", { stream, actor }, {});
    }
    for (let i = 0; i < 3; i++) {
      await app.correlate();
      await app.drain();
    }
    const head = async (stream: string) =>
      (await app.query_array({ stream, stream_exact: true })).at(-1)?.name;
    expect(await head("room-b")).toBe("__tombstone__");
    expect(await head("^room-a")).toBe("Done");
    await app.close([{ stream: "^room-a" }]);
    expect(await head("^room-a")).toBe("__tombstone__");
  });
});
