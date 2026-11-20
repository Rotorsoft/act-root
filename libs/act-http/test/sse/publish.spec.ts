/**
 * `publishCommits` publishes each commit once, in the shape the patch
 * subscriptions expect.
 */
import { act, state } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { BroadcastChannel, publishCommits } from "../../src/sse/index.js";

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Added: z.object({ by: z.number() }) })
  .patch({ Added: ({ data }, s) => ({ n: s.n + data.by }) })
  .on({ add: z.object({ by: z.number() }) })
  .emit((a) => ["Added", a])
  // Every second version takes a snapshot, which takes a version too.
  .snap((s) => s.patches >= 2)
  .build();

const test = fixture(act().withState(Counter));
const actor = { id: "a", name: "a" };

describe("publishCommits", () => {
  test("publishes each commit once, with _v and the stream's patches", async ({
    app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; n: number }>();
    const publish = vi.spyOn(channel, "publish");
    publishCommits(app, channel);
    await app.do("add", { stream: "c-1", actor }, { by: 2 });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith("c-1", { n: 2, _v: 0 }, [
      { n: 2 },
    ]);
    expect(channel.state("c-1")).toEqual({ n: 2, _v: 0 });
  });

  test("adds an empty patch when .snap took a version", async ({ app }) => {
    const channel = new BroadcastChannel<{ _v: number; n: number }>();
    const publish = vi.spyOn(channel, "publish");
    publishCommits(app, channel);
    await app.do("add", { stream: "c-2", actor }, { by: 1 });
    await app.do("add", { stream: "c-2", actor }, { by: 1 });
    const [, state, patches] = publish.mock.calls.at(-1)!;
    // The snapshot took version 2 after the event at version 1.
    expect(state).toEqual({ n: 2, _v: 2 });
    expect(patches).toEqual([{ n: 2 }, {}]);
  });

  test("publishes once per app and channel, until disposed", async ({
    app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; n: number }>();
    const publish = vi.spyOn(channel, "publish");
    const dispose = publishCommits(app, channel);
    expect(publishCommits(app, channel)).toBe(dispose);
    await app.do("add", { stream: "c-3", actor }, { by: 1 });
    expect(publish).toHaveBeenCalledOnce();
    dispose();
    await app.do("add", { stream: "c-3", actor }, { by: 1 });
    expect(publish).toHaveBeenCalledOnce();
    // Disposed, it can start again.
    publishCommits(app, channel);
    await app.do("add", { stream: "c-3", actor }, { by: 1 });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe("publishCommits with events", () => {
  test("publishes only commits of the named events", async ({ app }) => {
    const channel = new BroadcastChannel<{ _v: number; n: number }>();
    publishCommits(app, channel, { events: ["Other"] });
    await app.do("add", { stream: "c-9", actor }, { by: 1 });
    expect(channel.state("c-9")).toBeUndefined();
  });
});
