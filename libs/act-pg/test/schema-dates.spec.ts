import { act, state } from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PostgresStore } from "../src/index.js";

/**
 * #1556 on a durable adapter — the path that actually matters.
 *
 * InMemoryStore holds references, so a `Date` never becomes a string there and
 * revival is a no-op. Postgres serializes, so this is where the schema has to
 * do the typing: `z.date()` comes back a `Date`, and a `z.string()` holding an
 * ISO-looking value stays a string.
 */

const actor = { id: "a", name: "a" };
const kind = (v: unknown) => (v instanceof Date ? "Date" : typeof v);
const LOOKALIKE = "2026-06-06T00:00:00.000Z";

const Doc = state({
  Doc: z.object({ at: z.date(), label: z.string() }),
})
  .init(() => ({ at: new Date(0), label: "" }))
  .emits({ Stamped: z.object({ at: z.date(), label: z.string() }) })
  .patch({ Stamped: ({ data }) => data })
  .on({ stamp: z.object({ at: z.date(), label: z.string() }) })
  .emit("Stamped")
  .build();

describe("schema-driven dates over a serializing store (#1556)", () => {
  it("types z.date() and leaves an ISO-shaped z.string() alone", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const { app, store, cache, dispose } = await sandbox(act().withState(Doc), {
      store: () =>
        new PostgresStore({ port: 5431, schema: "sdates", table: "t" }),
    });
    await app.do("stamp", { stream: "d1", actor }, { at, label: LOOKALIKE });

    // The store returns bytes: both are strings on the wire.
    await store.query((e) => {
      const d = e.data as Record<string, unknown>;
      expect(typeof d.at).toBe("string");
      expect(typeof d.label).toBe("string");
    });

    // The framework types them from the declaration — warm and cold alike.
    const warm = await app.load(Doc, "d1");
    await cache.clear();
    const cold = await app.load(Doc, "d1");

    expect(kind(warm.state.at)).toBe("Date");
    expect(kind(cold.state.at)).toBe("Date");
    expect((cold.state.at as Date).getTime()).toBe(at.getTime());
    expect(kind(warm.state.label)).toBe("string");
    expect(kind(cold.state.label)).toBe("string");
    expect(cold.state.label).toBe(LOOKALIKE);

    await dispose();
  });
});
