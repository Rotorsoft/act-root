import { describe, expect, it } from "vitest";
import { z } from "zod";
import { act, state, ZodEmpty } from "../src/index.js";

const actor = { id: "a", name: "a" };

describe("the version of an action's result", () => {
  it("is the stream's head after a snapshot, so it pins the next action", async () => {
    const R = state({ R: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Hit: ZodEmpty })
      .patch({ Hit: (_, s) => ({ n: s.n + 1 }) })
      .on({ hit: ZodEmpty })
      .emit(() => ["Hit", {}])
      .snap(() => true)
      .build();
    const app = act().withState(R).build({ autoSettle: false });
    const [first] = await app.do("hit", { stream: "pinned", actor }, {});
    expect(first.version).toBe((await app.load(R, "pinned")).version);
    expect(first.event?.version).toBe(0);
    await expect(
      app.do(
        "hit",
        { stream: "pinned", actor, expectedVersion: first.version },
        {}
      )
    ).resolves.toHaveLength(1);
  });
});
