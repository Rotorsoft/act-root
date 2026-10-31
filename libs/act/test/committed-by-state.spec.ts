import { describe, expect, expectTypeOf, vi } from "vitest";
import { z } from "zod";
import { act, type Snapshot, state, ZodEmpty } from "../src/index.js";
import { fixture } from "../src/test/index.js";

/**
 * `app.on("committed", state, listener)` hears only commits by that state's
 * actions, with snapshots typed from it; the plain `committed` listener
 * still hears every commit, typed loosely.
 */

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_e, s) => ({ n: s.n + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

const Note = state({ Note: z.object({ text: z.string() }) })
  .init(() => ({ text: "" }))
  .emits({ Written: z.object({ text: z.string() }) })
  .patch({ Written: ({ data }) => ({ text: data.text }) })
  .on({ write: z.object({ text: z.string() }) })
  .emit((p) => ["Written", p])
  .build();

const test = fixture(act().withState(Counter).withState(Note));
const actor = { id: "a", name: "a" };

describe("a committed listener scoped to one state", () => {
  test("hears only that state's commits, by State or by name", async ({
    app,
  }) => {
    const by_state = vi.fn();
    const by_name = vi.fn();
    const every = vi.fn();
    app.on("committed", Counter, by_state);
    app.on("committed", "Note", by_name);
    app.on("committed", every);

    await app.do("tick", { stream: "c-1", actor }, {});
    await app.do("write", { stream: "n-1", actor }, { text: "hi" });

    expect(by_state).toHaveBeenCalledTimes(1);
    expect(by_state.mock.calls[0][0][0].state).toEqual({ n: 1 });
    expect(by_name).toHaveBeenCalledTimes(1);
    expect(by_name.mock.calls[0][0][0].state).toEqual({ text: "hi" });
    expect(every).toHaveBeenCalledTimes(2);
  });

  test("off removes it, by State and by name", async ({ app }) => {
    const listener = vi.fn();
    app.on("committed", Counter, listener);
    app.off("committed", Counter, listener);
    const by_name = vi.fn();
    app.on("committed", "Counter", by_name);
    app.off("committed", "Counter", by_name);

    await app.do("tick", { stream: "c-2", actor }, {});
    expect(listener).not.toHaveBeenCalled();
    expect(by_name).not.toHaveBeenCalled();
  });

  test("a throwing listener is contained, and the others still run", async ({
    app,
  }) => {
    const after = vi.fn();
    app.on("committed", Counter, () => {
      throw new Error("listener exploded");
    });
    app.on("committed", Counter, after);

    await expect(
      app.do("tick", { stream: "c-3", actor }, {})
    ).resolves.toHaveLength(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("refuses a state the app doesn't have", ({ app }) => {
    const Other = state({ Other: z.object({}) })
      .init(() => ({}))
      .emits({ Done: ZodEmpty })
      .patch({ Done: (_e, s) => s })
      .on({ finish: ZodEmpty })
      .emit(() => ["Done", {}])
      .build();
    expect(() => app.on("committed", Other, () => {})).toThrow(
      'committed: "Other" is not a state of this app'
    );
  });

  test("types the snapshots from the state", ({ app }) => {
    app.on("committed", Counter, (snapshots) => {
      expectTypeOf(snapshots[0].state).toEqualTypeOf<{ n: number }>();
    });
    app.on("committed", "Note", (snapshots) => {
      expectTypeOf(snapshots[0].state).toEqualTypeOf<{ text: string }>();
      // @ts-expect-error a field the state doesn't have
      snapshots[0].state.n;
    });
    app.on("committed", (snapshots) => {
      expectTypeOf(snapshots).toExtend<Snapshot<any, any>[]>();
    });
    // @ts-expect-error a name the app doesn't have
    expect(() => app.on("committed", "Nope", () => {})).toThrow();
  });
});
