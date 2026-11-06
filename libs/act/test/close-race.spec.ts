/**
 * Where two features meet in the pipeline: a commit stalled across a close, a
 * target read from two sources, settle against a failing ack, a throwing
 * `.snap`, and `stop_correlations` during a scan.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  dispose,
  InMemoryCache,
  InMemoryStore,
  log,
  type Store,
  StoreError,
  StreamClosedError,
  sleep,
  state,
  ZodEmpty,
} from "../src/index.js";

const actor = { id: "a", name: "a" };
const base = () =>
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

const scoped = (store: Store = new InMemoryStore()) => ({
  store,
  cache: new InMemoryCache(),
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dispose()();
});

describe("a commit stalled across a close", () => {
  it("a commit stalled across the close of a one-event stream is refused", async () => {
    const store = new InMemoryStore();
    const app = act()
      .withState(base().build())
      .build({ autoSettle: false, scoped: scoped(store) });
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

describe("a target read from two sources", () => {
  it("reports reactions resolving a source their target doesn't read", async () => {
    const error = vi.spyOn(log(), "error").mockImplementation(() => {});
    const seen: string[] = [];
    const app = act()
      .withState(base().build())
      .on("Hit")
      .do(async function first(e) {
        seen.push(e.stream);
      })
      .to((e) => ({ target: "T", source: e.stream }))
      .on("Done")
      .do(async function second(e) {
        seen.push(e.stream);
      })
      .to((e) => ({ target: "T", source: e.stream }))
      .build({ autoSettle: false, scoped: scoped() });
    await app.do("hit", { stream: "own", actor }, {});
    await app.correlate();
    await app.drain();
    await app.do("done", { stream: "res", actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen).toEqual(["own"]);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain(
      'resolved source "res"'
    );
  });

  it("warns about static reactions on two sources", () => {
    const warn = vi.spyOn(log(), "warn").mockImplementation(() => {});
    act()
      .withState(base().build())
      .on("Hit")
      .do(async function first() {})
      .to({ target: "T", source: "a" })
      .on("Done")
      .do(async function second() {})
      .to({ target: "T", source: "b" })
      .build({ autoSettle: false, scoped: scoped() });
    expect(warn.mock.calls.map(([m]) => String(m)).join()).toContain(
      'Target "T" has reactions on two sources'
    );
  });
});

describe("settle against a failing store", () => {
  it("a failing ack under settle doesn't block a healthy stream", async () => {
    const store = new InMemoryStore();
    await store.seed();
    store.ack = () =>
      Promise.reject(new StoreError("ack", { cause: new Error("busy") }));
    const app = act()
      .withState(base().build())
      .on("Hit")
      .do(async function h() {}, { maxRetries: 2 })
      .to({ target: "proj" })
      .build({
        circuitBreaker: { failureThreshold: 100, cooldownMs: 100_000 },
        scoped: scoped(store),
      });
    app.on("error", () => {});
    const blocked: unknown[] = [];
    app.on("blocked", (b) => blocked.push(...b));
    for (let i = 0; i < 8; i++) {
      await app.do("hit", { stream: "x", actor }, {});
      app.settle({ leaseMillis: 1, debounceMs: 1 });
      await sleep(25);
    }
    await app.shutdown();
    expect(blocked).toEqual([]);
  });
});

describe("after the commit landed", () => {
  it("a throwing snap predicate doesn't fail the action", async () => {
    const warn = vi.spyOn(log(), "warn").mockImplementation(() => {});
    const R = base()
      .snap(() => {
        throw new Error("boom");
      })
      .build();
    const app = act()
      .withState(R)
      .build({ autoSettle: false, scoped: scoped() });
    const [done] = await app.do("hit", { stream: "x", actor }, {});
    expect(done.event?.version).toBe(0);
    expect(warn.mock.calls.map(([m]) => String(m)).join()).toContain("boom");
  });

  it("stop_correlations keeps the scan in flight", async () => {
    const store = new InMemoryStore();
    await store.seed();
    const seen: number[] = [];
    let release: (() => void) | undefined;
    let parked = false;
    const query = store.query.bind(store);
    store.query = (async (callback: never, q: { with_pii?: boolean }) => {
      if (q?.with_pii === false && !parked) {
        parked = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return query(callback, q as never);
    }) as never;
    const app = act()
      .withState(base().build())
      .on("Hit")
      .do(async function h(e) {
        seen.push(e.id);
      })
      .to({ target: "proj" })
      .build({ settleDebounceMs: 1, scoped: scoped(store) });
    await app.do("hit", { stream: "x", actor }, {});
    while (!release) await sleep(2);
    app.stop_correlations();
    await sleep(5);
    release();
    await sleep(80);
    await app.shutdown();
    expect(seen).toHaveLength(1);
  });
});
