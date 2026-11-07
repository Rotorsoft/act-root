import { act, InMemoryCache, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { SqliteStore } from "../src/index.js";
import { rm_tmp_dbs, tmp_db_url } from "./tmp-db.js";

// One reaction on one odd stream name must not stop or lose the rest.
const actor = { id: "a", name: "a" };
const Thing = state({ Thing: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Done: ZodEmpty })
  .patch({ Done: (_, s) => ({ n: s.n + 1 }) })
  .on({ go: ZodEmpty })
  .emit(() => ["Done", {}])
  .build();

describe("default reactions on any stream name", () => {
  const store = new SqliteStore({ url: tmp_db_url() });

  beforeAll(async () => {
    await store.drop();
    await store.seed();
  });

  afterAll(async () => {
    await store.drop();
    await store.dispose();
    rm_tmp_dbs();
  });

  it("delivers them, and the other streams too", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(Thing)
      .on("Done")
      .do(async function record(e) {
        seen.push(e.stream);
      })
      .build({
        autoSettle: false,
        scoped: { store, cache: new InMemoryCache() },
      });
    const names = ["user+tag@example.com", "a(", "order(1)", "healthy"];
    for (const stream of names) await app.do("go", { stream, actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen.sort()).toEqual([...names].sort());
    const closed = await app.close([{ stream: "healthy" }]);
    expect(closed.truncated.has("healthy")).toBe(true);
  });
});
