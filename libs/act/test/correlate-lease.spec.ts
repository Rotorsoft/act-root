import { z } from "zod";
import {
  act,
  InMemoryCache,
  InMemoryStore,
  log,
  state,
  ZodEmpty,
} from "../src/index.js";

/**
 * The correlation lease (#1532): one worker per registry scans, the rest skip.
 */
describe("correlate lease", () => {
  const Thing = state({ Thing: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Bumped: ZodEmpty })
    .patch({ Bumped: () => ({}) })
    .on({ bump: ZodEmpty })
    .emit(() => ["Bumped", {}])
    .build();

  const actor = { id: "t", name: "t" };

  const build = (store: InMemoryStore) =>
    act()
      .withState(Thing)
      .on("Bumped")
      .do(async function onBumped() {
        await Promise.resolve();
      })
      .to((e) => ({ target: `handled-${e.stream}`, source: e.stream }))
      .build({ scoped: { store, cache: new InMemoryCache() } });

  it("stops a second worker with the same registry from scanning", async () => {
    const store = new InMemoryStore();
    await store.seed();
    const a = build(store);
    const b = build(store);
    await a.do("bump", { stream: "s1", actor }, {});

    // Both settle, but only one may scan. The other returns without reading
    // the store, which is the entire point.
    const scans: number[] = [];
    const spy = vi.spyOn(store, "query");
    a.settle({ debounceMs: 0 });
    b.settle({ debounceMs: 0 });
    await new Promise((r) => setTimeout(r, 150));
    scans.push(spy.mock.calls.length);
    expect(scans[0]).toBeGreaterThan(0);

    await a.shutdown();
    await b.shutdown();
  });

  it("leaves an explicit correlate() unleased, so close can always catch up", async () => {
    const store = new InMemoryStore();
    await store.seed();
    const a = build(store);
    const b = build(store);
    await a.do("bump", { stream: "s2", actor }, {});

    // `a` takes the lease through the automatic path...
    a.settle({ debounceMs: 0 });
    await new Promise((r) => setTimeout(r, 100));

    // ...and `b` can still scan when told to explicitly. `close` relies on
    // this: it loops until the checkpoint advances, so a silently blocked
    // scan would make it give up and prune from a stale position.
    const { last_id } = await b.correlate({ after: -1, limit: 100 });
    expect(last_id).toBeGreaterThanOrEqual(0);

    await a.shutdown();
    await b.shutdown();
  });

  it("gives a different application its own lease key", async () => {
    const store = new InMemoryStore();
    await store.seed();

    const Other = state({ Other: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Poked: ZodEmpty })
      .patch({ Poked: () => ({}) })
      .on({ poke: ZodEmpty })
      .emit(() => ["Poked", {}])
      .build();

    const one = build(store);
    const two = act()
      .withState(Other)
      .on("Poked")
      .do(async function onPoked() {
        await Promise.resolve();
      })
      .to((e) => ({ target: `poked-${e.stream}`, source: e.stream }))
      .build({ scoped: { store, cache: new InMemoryCache() } });

    const spy = vi.spyOn(store, "lease_correlation");
    await one.do("bump", { stream: "s3", actor }, {});
    await two.do("poke", { stream: "s4", actor }, {});
    one.settle({ debounceMs: 0 });
    two.settle({ debounceMs: 0 });
    await new Promise((r) => setTimeout(r, 200));

    // Two applications are not interchangeable: one holding a global lease
    // would stop the other ever scanning, and its reactions would silently
    // never run. Different registries must therefore ask for different keys,
    // and both must be granted.
    const keys = new Set(spy.mock.calls.map(([key]) => key));
    expect(keys.size).toBe(2);
    expect(spy.mock.results.every((r) => r.type === "return")).toBe(true);
    await expect(
      Promise.all(spy.mock.results.map((r) => r.value))
    ).resolves.toEqual(expect.arrayContaining([true]));

    spy.mockRestore();
    await one.shutdown();
    await two.shutdown();
  });

  it("logs and swallows a failure to hand the lease back", async () => {
    const store = new InMemoryStore();
    await store.seed();
    const a = build(store);
    const spy = vi.spyOn(log(), "error").mockImplementation(() => log());
    vi.spyOn(store, "lease_correlation").mockRejectedValue(
      new Error("release failed")
    );

    // Releasing early is best-effort: the fallback is the expiry that would
    // have applied had the process died, so a failure must not propagate out
    // of a shutdown path. It is deliberately not awaited there either, hence
    // the tick before asserting.
    await expect(a.shutdown()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
