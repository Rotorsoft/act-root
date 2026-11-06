import {
  act,
  InMemoryCache,
  InMemoryStore,
  state,
  ZodEmpty,
} from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hybridStore } from "./hybrid-store.js";

const actor = { id: "a", name: "a" };
const R = state({ R: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Hit: ZodEmpty })
  .patch({ Hit: (_, s) => ({ n: s.n + 1 }) })
  .on({ hit: ZodEmpty })
  .emit(() => ["Hit", {}])
  .build();

describe("hybrid store", () => {
  it("a commit after restoring a shorter log reaches its reaction", async () => {
    const store = hybridStore(new InMemoryStore(), new InMemoryStore());
    await store.seed();
    const seen: string[] = [];
    const app = act()
      .withState(R)
      .on("Hit")
      .do(async function h(e) {
        seen.push(e.stream);
      })
      .to({ target: "log" })
      .build({
        autoSettle: false,
        scoped: { store, cache: new InMemoryCache() },
      });
    const cycle = async () => {
      for (let i = 0; i < 3; i++) {
        await app.correlate();
        await app.drain();
      }
    };
    for (let i = 0; i < 6; i++)
      await app.do("hit", { stream: `s-${i}`, actor }, {});
    await cycle();
    const rows: Parameters<Parameters<typeof store.query>[0]>[0][] = [];
    await store.query((e) => {
      rows.push(e);
    });
    await app.restore({
      query: async (
        callback: (event: (typeof rows)[number]) => unknown,
        query?: { after?: number }
      ) => {
        let count = 0;
        for (const row of rows.slice(0, 2)) {
          if (query?.after !== undefined && row.id <= query.after) continue;
          await callback(row);
          count++;
        }
        return count;
      },
    } as never);
    await cycle();
    seen.length = 0;
    await app.do("hit", { stream: "new", actor }, {});
    await cycle();
    expect(seen).toEqual(["new"]);
  });
});
