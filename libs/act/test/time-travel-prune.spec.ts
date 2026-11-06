/**
 * Time travel skips the resume floor, not the snapshots: after a windowed close
 * or a restart, a snapshot is all that holds the effect of the events it replaced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, dispose, sleep, state, store, ZodEmpty } from "../src/index.js";

const actor = { id: "a", name: "a" };
const base = () =>
  state({ R: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Hit: ZodEmpty })
    .patch({ Hit: (_, s) => ({ n: s.n + 1 }) })
    .on({ hit: ZodEmpty })
    .emit(() => ["Hit", {}]);

const later = () => ({ created_before: new Date(Date.now() + 3_600_000) });

describe("time travel after history moved into a snapshot", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("keeps the state a windowed close moved into a snapshot", async () => {
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

  it("pushes a limit down to the store, so it doesn't read the whole stream", async () => {
    const R = base().build();
    const app = act().withState(R).build({ autoSettle: false });
    for (let i = 0; i < 4; i++)
      await app.do("hit", { stream: "limited", actor }, {});
    const query = vi.spyOn(store(), "query");
    const { state: past } = await app.load(R, "limited", undefined, {
      limit: 2,
    });
    expect(past.n).toBe(2);
    expect(query.mock.calls.at(-1)?.[1]).toMatchObject({ limit: 2 });
    query.mockRestore();
  });

  it("keeps the state a restart seeded", async () => {
    const R = base().build();
    const app = act().withState(R).build({ autoSettle: false });
    for (let i = 0; i < 5; i++)
      await app.do("hit", { stream: "restarted", actor }, {});
    await app.close([{ stream: "restarted", restart: true }]);
    await app.do("hit", { stream: "restarted", actor }, {});
    const { state: past } = await app.load(R, "restarted", undefined, later());
    expect(past.n).toBe(6);
  });
});
