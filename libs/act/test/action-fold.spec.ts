import { z } from "zod";
import { act, dispose, state } from "../src/index.js";

describe("one fold, before the commit", () => {
  // The decider rule: an action folds its events once, before the commit.
  // Reducers see the event data and the next version; the store assigns
  // `id` and `created`, so they get placeholders (`-1`, the commit time).
  // The returned snapshot carries the stored row.
  it("folds each event once, with the next version and a placeholder id", async () => {
    const seen: Array<{ id: number; version: number; created: Date }> = [];
    const Tally = state({ Tally: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Added: z.object({ by: z.number() }) })
      .patch({
        Added: ({ id, version, created, data }, s) => {
          seen.push({ id, version, created });
          return { n: s.n + data.by };
        },
      })
      .on({ add: z.object({ by: z.number() }) })
      .emit((a) => [
        ["Added", { by: a.by }],
        ["Added", { by: a.by }],
      ])
      .build();
    const app = act().withState(Tally).build({ autoSettle: false });
    const actor = { id: "a", name: "a" };
    const snaps = await app.do("add", { stream: "tally", actor }, { by: 2 });
    expect(seen.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: -1, version: 0 },
      { id: -1, version: 1 },
    ]);
    expect(seen[0].created).toBeInstanceOf(Date);
    const stored = await app.query_array({ stream: "tally" });
    expect(snaps.map((s) => s.event?.id)).toEqual(stored.map((e) => e.id));
    expect(snaps.at(-1)?.state).toEqual({ n: 4 });
    await dispose()();
  });
});
