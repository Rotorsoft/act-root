import { z } from "zod";
import { act, projection, sleep, state } from "../src/index.js";
import { event_tags, make_date_reviver } from "../src/internal/index.js";
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
  it("resolves sensitive fields and date paths in one pass", () => {
    const tags = event_tags(
      z.object({
        at: z.date(),
        label: z.string(),
        nested: z.object({ born: z.date() }),
        maybe: z.date().optional(),
      })
    );
    expect(tags.dates).toEqual([["at"], ["nested", "born"], ["maybe"]]);
    expect(tags.sensitive).toEqual([]);
  });

  it("builds no reviver when a schema declares no dates", () => {
    expect(
      make_date_reviver(event_tags(z.object({ a: z.string() })).dates)
    ).toBeUndefined();
  });

  it("converts a stored string, at any depth", () => {
    // What a durable adapter hands back: JSON has no date type, so the
    // value arrives as its ISO form and the declared path types it.
    const revive = make_date_reviver([["at"], ["meta", "born"]])!;
    const data: Record<string, any> = {
      at: "2026-01-01T00:00:00.000Z",
      meta: { born: "1990-02-03T00:00:00.000Z" },
    };
    revive(data);
    expect(data.at).toBeInstanceOf(Date);
    expect((data.at as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(data.meta.born).toBeInstanceOf(Date);
  });

  it("leaves an absent or already-typed value alone", () => {
    // InMemory holds references, so the value can already be a `Date`; and a
    // path the payload doesn't carry must not throw.
    const revive = make_date_reviver([["at"], ["missing", "deep"]])!;
    const already = new Date("2020-01-01");
    const data: Record<string, unknown> = { at: already };
    revive(data);
    expect(data.at).toBe(already); // untouched, not re-wrapped
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
});
