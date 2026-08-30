import { z } from "zod";
import { event_tags } from "../src/builders/event-builder.js";
import { act, projection, sleep, state } from "../src/index.js";
import { sandbox } from "../src/test/index.js";

/**
 * The schema decides which fields are dates (#1556).
 *
 * JSON has no date type, so a `Date` is stored as a string. An adapter cannot
 * know which strings were dates and used to guess from shape, which revived
 * any ISO-8601-looking string — including fields a schema declared
 * `z.string()`. The declaration is the authority, so the paths are resolved
 * once at build and the read path converts exactly those.
 */

const actor = { id: "a", name: "a" };
const kind = (v: unknown) => (v instanceof Date ? "Date" : typeof v);
const ISO_LOOKALIKE = "2026-06-06T00:00:00.000Z";

const Doc = state({
  Doc: z.object({
    at: z.date(),
    label: z.string(),
    meta: z.object({ born: z.date(), tag: z.string() }),
  }),
})
  .init(() => ({
    at: new Date(0),
    label: "",
    meta: { born: new Date(0), tag: "" },
  }))
  .emits({
    Stamped: z.object({
      at: z.date(),
      label: z.string(),
      meta: z.object({ born: z.date(), tag: z.string() }),
    }),
  })
  .patch({ Stamped: ({ data }) => data })
  .on({
    stamp: z.object({
      at: z.date(),
      label: z.string(),
      meta: z.object({ born: z.date(), tag: z.string() }),
    }),
  })
  .emit("Stamped")
  .build();

const payload = {
  at: new Date("2026-01-01T00:00:00.000Z"),
  label: ISO_LOOKALIKE, // declared a string; must stay one
  meta: { born: new Date("1990-02-03T00:00:00.000Z"), tag: "x" },
};

describe("schema-driven date revival (#1556)", () => {
  it("resolves sensitive fields and a read parser in one pass", () => {
    const tags = event_tags(
      z.object({
        at: z.date(),
        label: z.string(),
        nested: z.object({ born: z.date() }),
        list: z.array(z.object({ when: z.date() })),
        rec: z.record(z.string(), z.date()),
      })
    );
    expect(tags.sensitive).toEqual([]);
    expect(tags.date_reviver).toBeTypeOf("function");

    // Zod does the work, so nesting, arrays and records all type correctly —
    // the shapes a hand-rolled path walk would have had to re-implement.
    const out = tags.date_reviver!({
      at: "2026-01-01T00:00:00.000Z",
      label: "2026-06-06T00:00:00.000Z",
      nested: { born: "1990-02-03T00:00:00.000Z" },
      list: [{ when: "2020-01-01T00:00:00.000Z" }],
      rec: { k: "2021-01-01T00:00:00.000Z" },
    }) as Record<string, any>;
    expect(kind(out.at)).toBe("Date");
    expect(kind(out.nested.born)).toBe("Date");
    expect(kind(out.list[0].when)).toBe("Date");
    expect(kind(out.rec.k)).toBe("Date");
    // Declared a string — an ISO-looking value must survive as one.
    expect(kind(out.label)).toBe("string");
  });

  it("builds no reader when a schema declares no dates", () => {
    expect(
      event_tags(z.object({ a: z.string() })).date_reviver
    ).toBeUndefined();
  });

  it("keeps keys the schema does not declare", () => {
    // Event stores hold payloads written against older schemas. A strict Zod
    // object would silently drop them; losing committed data on read would be
    // worse than the mistyping this fixes.
    const read = event_tags(z.object({ at: z.date() })).date_reviver!;
    const out = read({
      at: "2026-01-01T00:00:00.000Z",
      legacy: "written before this field was removed",
    }) as Record<string, unknown>;
    expect(out.legacy).toBe("written before this field was removed");
  });

  it("types dates through unions, optionals and nullables", () => {
    const read = event_tags(
      z.object({
        maybe: z.date().optional(),
        orNull: z.date().nullable(),
        either: z.union([
          z.object({ on: z.date() }),
          z.object({ n: z.number() }),
        ]),
      })
    ).date_reviver!;
    const out = read({
      maybe: "2026-01-01T00:00:00.000Z",
      orNull: null,
      either: { on: "2020-01-01T00:00:00.000Z" },
    }) as Record<string, any>;
    expect(kind(out.maybe)).toBe("Date");
    expect(out.orNull).toBeNull();
    expect(kind(out.either.on)).toBe("Date");
  });

  it("passes through a construct it does not rebuild", () => {
    // The fallthrough is what keeps the transform small: an unfamiliar schema
    // still parses, it just doesn't coerce dates buried inside one.
    const tags = event_tags(
      z.object({ at: z.date(), blob: z.map(z.string(), z.string()) })
    );
    const m = new Map([["k", "v"]]);
    const out = tags.date_reviver!({
      at: "2026-01-01T00:00:00.000Z",
      blob: m,
    }) as Record<string, any>;
    expect(kind(out.at)).toBe("Date");
    expect(out.blob).toEqual(m);
  });

  it("returns a non-zod node untouched rather than throwing", () => {
    // Guards the recursion: a malformed or foreign node reached through a
    // child slot must pass through, not crash the build.
    const foreign = { not: "a zod schema" } as unknown as z.ZodType;
    expect(event_tags(foreign).date_reviver).toBeUndefined();
    expect(event_tags(foreign).sensitive).toEqual([]);

    // An object def with no shape takes the same path.
    const shapeless = {
      _zod: { def: { type: "object" } },
    } as unknown as z.ZodType;
    expect(event_tags(shapeless).date_reviver).toBeUndefined();
  });

  it("leaves an already-typed value alone", () => {
    // InMemory holds references, so the value can already be a `Date`.
    const read = event_tags(z.object({ at: z.date() })).date_reviver!;
    const already = new Date("2020-01-01T00:00:00.000Z");
    const out = read({ at: already }) as { at: Date };
    expect(out.at.getTime()).toBe(already.getTime());
  });

  it("types a folded state by its declaration, warm and cold", async () => {
    const { app, cache, dispose } = await sandbox(act().withState(Doc));
    await app.do("stamp", { stream: "d1", actor }, payload);

    const warm = await app.load(Doc, "d1");
    await cache.clear();
    const cold = await app.load(Doc, "d1");

    for (const [when, snap] of [
      ["warm", warm],
      ["cold", cold],
    ] as const) {
      expect(`${when}:${kind(snap.state.at)}`).toBe(`${when}:Date`);
      expect(`${when}:${kind(snap.state.meta.born)}`).toBe(`${when}:Date`);
      // Declared `z.string()` — an ISO-looking value must NOT be revived.
      expect(`${when}:${kind(snap.state.label)}`).toBe(`${when}:string`);
      expect(`${when}:${snap.state.label}`).toBe(`${when}:${ISO_LOOKALIKE}`);
    }
    await dispose();
  });

  it("survives a snapshot, whose data is folded state not event data", async () => {
    const Snapped = state({ Snapped: z.object({ at: z.date() }) })
      .init(() => ({ at: new Date(0) }))
      .emits({ Ticked: z.object({ at: z.date() }) })
      .patch({ Ticked: ({ data }) => ({ at: data.at }) })
      .on({ tick: z.object({ at: z.date() }) })
      .emit("Ticked")
      .snap(() => true)
      .build();

    const { app, cache, dispose } = await sandbox(act().withState(Snapped));
    const at = new Date("2026-03-03T00:00:00.000Z");
    await app.do("tick", { stream: "s1", actor }, { at });
    await cache.clear();

    const cold = await app.load(Snapped, "s1");
    expect(kind(cold.state.at)).toBe("Date");
    expect((cold.state.at as Date).getTime()).toBe(at.getTime());
    await dispose();
  });

  it("types query and query_array by declaration", async () => {
    const { app, dispose } = await sandbox(act().withState(Doc));
    await app.do("stamp", { stream: "d2", actor }, payload);

    const [viaArray] = await app.query_array({
      stream: "d2",
      stream_exact: true,
    });
    const seen: unknown[] = [];
    await app.query({ stream: "d2", stream_exact: true }, (e) =>
      seen.push(e.data)
    );

    for (const data of [viaArray.data, seen[0]] as Array<Record<string, any>>) {
      expect(kind(data.at)).toBe("Date");
      expect(kind(data.meta.born)).toBe("Date");
      expect(kind(data.label)).toBe("string");
    }
    await dispose();
  });

  it("types the events a reaction handler receives", async () => {
    const seen: Record<string, string> = {};
    const { app, dispose } = await sandbox(
      act()
        .withState(Doc)
        .on("Stamped")
        .do(async function reader(event) {
          const d = event.data as Record<string, any>;
          seen.at = kind(d.at);
          seen.born = kind(d.meta.born);
          seen.label = kind(d.label);
        })
        .to({ target: "reader" })
    );
    await app.do("stamp", { stream: "d3", actor }, payload);
    await app.correlate();
    await app.drain();

    expect(seen).toEqual({ at: "Date", born: "Date", label: "string" });
    await dispose();
  });

  it("types the events a batch projection receives", async () => {
    const seen: Record<string, string> = {};
    const Proj = projection("dates-proj")
      .on({
        Stamped: z.object({
          at: z.date(),
          label: z.string(),
          meta: z.object({ born: z.date(), tag: z.string() }),
        }),
      })
      .do(async function one() {})
      .batch(async function many(events) {
        const d = events[0].data as Record<string, any>;
        seen.at = kind(d.at);
        seen.label = kind(d.label);
      })
      .build();

    const { app, dispose } = await sandbox(
      act().withState(Doc).withProjection(Proj)
    );
    await app.do("stamp", { stream: "d4", actor }, payload);
    await app.correlate();
    await app.drain();
    await sleep(10);

    expect(seen).toEqual({ at: "Date", label: "string" });
    await dispose();
  });

  it("revives dates in the variant a union payload actually matches", () => {
    // The variants share a key: `at` is a string in one and a date in the
    // other. Reducing a variant to its date paths would make every variant
    // match every payload, so the first one wins and the wrong rule applies.
    const U = z.union([
      z.object({ k: z.literal("b"), at: z.string() }),
      z.object({ k: z.literal("a"), at: z.date() }),
    ]);
    const revive = event_tags(U).date_reviver!;
    expect(revive({ k: "a", at: "2020-01-01T00:00:00.000Z" })).toEqual({
      k: "a",
      at: new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(revive({ k: "b", at: "2020-01-01T00:00:00.000Z" })).toEqual({
      k: "b",
      at: "2020-01-01T00:00:00.000Z",
    });
  });

  it("revives a union's date when a variant without one is declared first", () => {
    const U = z.union([
      z.object({ k: z.literal("b"), n: z.number() }),
      z.object({ k: z.literal("a"), at: z.date() }),
    ]);
    const out = event_tags(U).date_reviver!({
      k: "a",
      at: "2020-01-01T00:00:00.000Z",
    }) as { at: unknown };
    expect(out.at).toBeInstanceOf(Date);
  });

  it("builds nothing for a union with no dates in any variant", () => {
    const U = z.union([
      z.object({ k: z.literal("a") }),
      z.object({ k: z.literal("b"), n: z.number() }),
    ]);
    expect(event_tags(U).date_reviver).toBeUndefined();
  });

  it("still revives a union variant when a field it declares is missing", () => {
    const U = z.union([
      z.object({ k: z.literal("a"), at: z.date(), added_later: z.string() }),
      z.object({ k: z.literal("b") }),
    ]);
    const out = event_tags(U).date_reviver!({
      k: "a",
      at: "2020-01-01T00:00:00.000Z",
    }) as { at: unknown };
    expect(out.at).toBeInstanceOf(Date);
  });

  it("revives a union told apart by field type, not a discriminator", () => {
    // No literal to discriminate on: the variants differ only in the TYPE of
    // `v`, and `at` is a date in one and a string in the other. This is why a
    // variant keeps its fields — narrow them and the first variant matches
    // everything, so the one that declared the date is never tried.
    const U = z.union([
      z.object({ v: z.number(), at: z.string() }),
      z.object({ v: z.string(), at: z.date() }),
    ]);
    const revive = event_tags(U).date_reviver!;
    expect(revive({ v: "x", at: "2020-01-01T00:00:00.000Z" })).toEqual({
      v: "x",
      at: new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(revive({ v: 7, at: "2020-01-01T00:00:00.000Z" })).toEqual({
      v: 7,
      at: "2020-01-01T00:00:00.000Z",
    });
  });
});
