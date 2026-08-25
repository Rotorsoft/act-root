import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { act, state } from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { z } from "zod";
import { SqliteStore } from "../src/index.js";

/**
 * #1556 on the second serializing adapter.
 *
 * The store TCK already pins what a *store* owes here — lossless recovery of
 * a `Date`, identically in `data` and `pii` — and deliberately allows the
 * runtime type to differ, because an adapter cannot know which strings were
 * dates. Typing them is the orchestrator's job, driven by the declared
 * `z.date()`.
 *
 * That orchestrator half cannot live in the store TCK: `runStoreTck` is
 * handed a bare `Store` and never builds an `Act`. So it is pinned per
 * serializing adapter, and act-pg was the only one that had it — leaving
 * SQLite's JSON storage unguarded against a regression in the event reader.
 */

const DB_PATH = join(import.meta.dirname, "schema-dates.db");
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

describe("schema-driven dates over sqlite (#1556)", () => {
  afterAll(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(DB_PATH + ext);
      } catch {
        // file may not exist
      }
    }
  });

  it("types z.date() and leaves an ISO-shaped z.string() alone", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const { app, store, cache, dispose } = await sandbox(act().withState(Doc), {
      store: () => new SqliteStore({ url: `file:${DB_PATH}` }),
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

    // The lookalike is the point: shape-based revival turned this into a
    // Date, which the declared z.string() does not permit.
    expect(kind(warm.state.label)).toBe("string");
    expect(kind(cold.state.label)).toBe("string");
    expect(cold.state.label).toBe(LOOKALIKE);

    await dispose();
  });
});
