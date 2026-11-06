/**
 * A `.snap` predicate runs after the commit landed, so what it does can't change
 * what the caller is told about the action.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, dispose, log, state, ZodEmpty } from "../src/index.js";

const actor = { id: "a", name: "a" };

describe("a .snap predicate", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose()();
  });

  it("a throwing snap predicate doesn't fail the action", async () => {
    const warn = vi.spyOn(log(), "warn").mockImplementation(() => {});
    const R = state({ R: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Hit: ZodEmpty })
      .patch({ Hit: (_, s) => ({ n: s.n + 1 }) })
      .on({ hit: ZodEmpty })
      .emit(() => ["Hit", {}])
      .snap(() => {
        throw new Error("boom");
      })
      .build();
    const app = act().withState(R).build({ autoSettle: false });
    const [done] = await app.do("hit", { stream: "x", actor }, {});
    expect(done.event?.version).toBe(0);
    expect(warn.mock.calls.map(([m]) => String(m)).join()).toContain("boom");
  });
});
