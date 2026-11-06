/**
 * A commit that loaded before a close and lands after it. A full close of a
 * one-event stream brings the head back to the same version, so a store has to
 * look at what the head is, not only where.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  dispose,
  InMemoryCache,
  InMemoryStore,
  StreamClosedError,
  state,
  ZodEmpty,
} from "../src/index.js";

const actor = { id: "a", name: "a" };
const hits = () =>
  state({ R: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Hit: ZodEmpty, Done: ZodEmpty })
    .patch({
      Hit: (_, s) => ({ n: s.n + 1 }),
      Done: (_, s) => ({ n: s.n + 1 }),
    })
    .on({ hit: ZodEmpty })
    .emit(() => ["Hit", {}])
    .on({ done: ZodEmpty })
    .emit(() => ["Done", {}]);

describe("a commit stalled across a close", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose()();
  });

  it("a commit stalled across the close of a one-event stream is refused", async () => {
    const store = new InMemoryStore();
    const app = act()
      .withState(hits().build())
      .build({
        autoSettle: false,
        scoped: { store, cache: new InMemoryCache() },
      });
    await app.do("hit", { stream: "one", actor }, {});
    const commit = store.commit.bind(store);
    vi.spyOn(store, "commit").mockImplementationOnce(async (...args) => {
      await app.close([{ stream: "one" }]);
      return commit(...args);
    });
    await expect(app.do("hit", { stream: "one", actor }, {})).rejects.toThrow();
    vi.restoreAllMocks();
    await expect(
      app.do("hit", { stream: "one", actor }, {})
    ).rejects.toBeInstanceOf(StreamClosedError);
    const names = (await app.query_array({ stream: "one" })).map((e) => e.name);
    expect(names).toEqual(["__tombstone__"]);
  });

  it("a restored or new event at the head reopens nothing by itself", async () => {
    const store = new InMemoryStore();
    const meta = { correlation: "", causation: {} };
    const ev = [{ name: "E", data: {} }];
    await store.commit("s", [{ name: "__tombstone__", data: {} }], meta);
    await expect(store.commit("s", ev, meta, 0)).rejects.toThrow();
    // Unguarded, as a direct caller may: only an action's guard is refused.
    await store.commit("s", ev, meta);
    await expect(store.commit("s", ev, meta, 1)).resolves.toHaveLength(1);
    const backup = new InMemoryStore();
    await backup.commit("t", [{ name: "__tombstone__", data: {} }], meta);
    await store.restore!(async (callback) => {
      await backup.query(async (e) => {
        await callback(e);
      });
    });
    await expect(store.commit("t", ev, meta, 0)).rejects.toThrow();
  });
});
