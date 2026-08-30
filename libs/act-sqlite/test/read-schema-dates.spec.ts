/**
 * Reading converts, it never validates (#1594).
 *
 * On a serializing adapter deliberately: InMemory holds the original objects
 * and never round-trips a date through its ISO form, so it cannot see any of
 * this.
 */
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { act, cache, dispose, sensitive, state, store } from "@rotorsoft/act";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SqliteStore } from "../src/index.js";

const actor = { id: "reader", name: "Reader" };
const paths: string[] = [];

async function open_store(name: string) {
  const path = join(import.meta.dirname, `test-rsd-${name}.db`);
  paths.push(path);
  try {
    unlinkSync(path);
  } catch {}
  store(new SqliteStore({ url: `file:${path}` }));
  await store().seed();
  await cache().clear();
}

afterEach(async () => {
  await dispose()();
  for (const p of paths.splice(0)) {
    try {
      unlinkSync(p);
    } catch {}
  }
});

describe("read schema converts dates without validating (#1594)", () => {
  it("a required sensitive field lives in `pii`, and reading still works", async () => {
    await open_store("a");
    const Happened = z.object({ at: z.date(), email: sensitive(z.string()) });
    const S = state({ A: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Happened })
      .patch({ Happened: (_, s) => ({ n: s.n + 1 }) })
      .on({ Do: Happened })
      .emit((p) => ["Happened", p])
      .build();
    const app = act().withState(S).build();

    await app.do(
      "Do",
      { stream: "a1", actor },
      {
        at: new Date("2020-01-01"),
        email: "u@example.com",
      }
    );

    const data = (await app.query_array({}))[0]!.data as {
      at: unknown;
      email: unknown;
    };
    expect(data.at).toBeInstanceOf(Date);
    expect(data.email).toBe("[REDACTED]");

    // load works, so the stream still accepts commands
    const snap = await app.load(S, "a1");
    expect(snap.state.n).toBe(1);
    await expect(
      app.do(
        "Do",
        { stream: "a1", actor },
        {
          at: new Date("2020-06-01"),
          email: "v@example.com",
        }
      )
    ).resolves.toBeDefined();
  });

  it("a disclosed sensitive date reaches the reducer as a Date, like its plain sibling", async () => {
    await open_store("b");
    const seen: Record<string, string> = {};
    const Happened = z.object({ at: z.date(), born: sensitive(z.date()) });
    const S = state({ B: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Happened })
      .patch({
        Happened: ({ data }, s) => {
          seen.at = data.at instanceof Date ? "Date" : typeof data.at;
          seen.born = data.born instanceof Date ? "Date" : typeof data.born;
          return { n: s.n + 1 };
        },
      })
      .on({ Do: Happened })
      .emit((p) => ["Happened", p])
      .discloses(() => true)
      .build();
    const app = act().withState(S).build();

    await app.do(
      "Do",
      { stream: "b1", actor },
      {
        at: new Date("2020-01-01"),
        born: new Date("1990-02-03"),
      }
    );
    await cache().clear(); // fold cold, from the store
    seen.at = seen.born = "";
    await app.load(S, { stream: "b1", actor });
    expect(seen).toEqual({ at: "Date", born: "Date" });
  });

  it("a redacted sensitive date keeps its sentinel instead of becoming a date", async () => {
    await open_store("c");
    const Happened = z.object({ at: z.date(), born: sensitive(z.date()) });
    const S = state({ C: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Happened })
      .patch({ Happened: (_, s) => ({ n: s.n + 1 }) })
      .on({ Do: Happened })
      .emit((p) => ["Happened", p])
      .build();
    const app = act().withState(S).build();

    await app.do(
      "Do",
      { stream: "c1", actor },
      {
        at: new Date("2020-01-01"),
        born: new Date("1990-02-03"),
      }
    );
    const data = (await app.query_array({}))[0]!.data as {
      at: unknown;
      born: unknown;
    };
    expect(data.at).toBeInstanceOf(Date);
    expect(data.born).toBe("[REDACTED]");
  });

  it("revives a date through every wrapper the rebuild knows", async () => {
    await open_store("d");
    const Happened = z.object({
      a: z.date(),
      b: z.date().default(() => new Date(0)),
      t: z.tuple([z.date(), z.string()]),
      r: z.date().readonly(),
      c: z.date().catch(() => new Date(0)),
      n: z.date().optional().nonoptional(),
      p: z.date().prefault(() => new Date(0)),
      u: z.union([z.date(), z.string()]),
      l: z.array(z.date()),
      m: z.record(z.string(), z.date()),
      o: z.object({ deep: z.date() }),
      x: z.date().nullable(),
    });
    const S = state({ D: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Happened })
      .patch({ Happened: (_, s) => ({ n: s.n + 1 }) })
      .on({ Do: Happened })
      .emit((p) => ["Happened", p])
      .build();
    const app = act().withState(S).build();

    const when = new Date("2022-01-01");
    await app.do(
      "Do",
      { stream: "d1", actor },
      {
        a: new Date("2020-01-01"),
        b: new Date("2021-01-01"),
        t: [when, "x"],
        r: when,
        c: when,
        n: when,
        p: when,
        u: when,
        l: [when],
        m: { k: when },
        o: { deep: when },
        x: null,
      }
    );
    const d = (await app.query_array({}))[0]!.data as Record<string, any>;
    for (const key of ["a", "b", "r", "c", "n", "p", "u"])
      expect(d[key], key).toBeInstanceOf(Date);
    expect(d.t[0]).toBeInstanceOf(Date);
    expect(d.t[1]).toBe("x");
    expect(d.l[0]).toBeInstanceOf(Date);
    expect(d.m.k).toBeInstanceOf(Date);
    expect(d.o.deep).toBeInstanceOf(Date);
    expect(d.x).toBeNull();
  });

  it("hands back what is stored when the payload predates the declaration", async () => {
    await open_store("f");
    const Happened = z.object({ at: z.date(), label: z.string() });
    const S = state({ F: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Happened })
      .patch({ Happened: (_, s) => ({ n: s.n + 1 }) })
      .on({ Do: Happened })
      .emit((p) => ["Happened", p])
      .build();
    const app = act().withState(S).build();

    // written before `label` was added to the declaration
    await store().commit(
      "f1",
      [{ name: "Happened", data: { at: new Date("2020-01-01") } } as never],
      { correlation: "c", causation: {} },
      -1
    );

    const data = (await app.query_array({}))[0]!.data as {
      at: unknown;
      label: unknown;
    };
    // reading does not throw, and the stored value comes back as stored
    expect(data.label).toBeUndefined();
    expect(typeof data.at).toBe("string");
  });

  it("leaves an ISO-shaped z.string() a string (#1556 stays fixed)", async () => {
    await open_store("e");
    const Happened = z.object({ at: z.date(), created_at: z.string() });
    const S = state({ E: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Happened })
      .patch({ Happened: (_, s) => ({ n: s.n + 1 }) })
      .on({ Do: Happened })
      .emit((p) => ["Happened", p])
      .build();
    const app = act().withState(S).build();

    await app.do(
      "Do",
      { stream: "e1", actor },
      {
        at: new Date("2020-01-01"),
        created_at: "2020-05-05T00:00:00.000Z",
      }
    );
    const d = (await app.query_array({}))[0]!.data as {
      at: unknown;
      created_at: unknown;
    };
    expect(d.at).toBeInstanceOf(Date);
    expect(typeof d.created_at).toBe("string");
  });
});
