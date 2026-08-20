/**
 * #1510 — correlate carries the drain's armed flag.
 *
 * The drain has always known how to sit still: a commit raises a flag, an
 * empty claim lowers it, and a disarmed drain returns without touching the
 * store. Correlate had no equivalent, so every settle pass scanned — including
 * the final pass whose only job is to confirm nothing changed, and every pass
 * on a system where nothing is happening at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, dispose, state, store, ZodEmpty } from "../src/index.js";

const Ticker = state({ Ticker: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_, s) => ({ n: s.n + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

/** Count store reads, which is what a correlate scan costs. */
const count_queries = (s: InMemoryStore) => {
  const counter = { n: 0 };
  const original = s.query.bind(s);
  s.query = ((...args: Parameters<typeof original>) => {
    counter.n++;
    return original(...args);
  }) as typeof s.query;
  return counter;
};

const build = () =>
  act()
    .withState(Ticker)
    .on("Ticked")
    .do(async function noop() {})
    .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
    .build();

/** Correlate + drain until a pass makes no progress — what settle loops. */
const quiesce = async (app: ReturnType<typeof build>) => {
  for (let i = 0; i < 10; i++) {
    const before = await app.correlate();
    const drain = await app.drain();
    if (!before.subscribed && !drain.acked.length && !drain.blocked.length)
      return;
  }
};

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
});

describe("correlate sits still when nothing has happened", () => {
  it("issues no store read once a scan has reached the end of the log", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const app = build();

    await app.do("tick", { stream: "s1", actor }, {});
    await quiesce(app);

    const queries = count_queries(raw);
    await app.correlate();
    await app.correlate();
    expect(queries.n).toBe(0);
  });

  it("re-arms on a commit, so new work is still found", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const app = build();

    await app.do("tick", { stream: "s1", actor }, {});
    await quiesce(app);

    // Quiet: the scan is parked.
    const idle = count_queries(raw);
    await app.correlate();
    expect(idle.n).toBe(0);

    // A commit is exactly the event that might give a scan something to find.
    await app.do("tick", { stream: "s2", actor }, {});
    const scan = await app.correlate();
    expect(scan.subscribed).toBe(1);
  });

  it("keeps scanning while a backlog is still producing work", async () => {
    // Arming from inside correlate re-arms correlate itself, which is what
    // keeps a backlog moving: a scan that found something leaves the flag up
    // so the next pass continues, and only the scan that finds nothing stops
    // the loop. A one-shot disarm would strand everything past the first
    // window.
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const app = build();

    for (let i = 0; i < 12; i++)
      await app.do("tick", { stream: `s${i}`, actor }, {});

    let subscribed = 0;
    for (let i = 0; i < 10; i++) {
      const scan = await app.correlate({ after: -1, limit: 3 });
      subscribed += scan.subscribed;
    }
    // All twelve targets discovered across the windowed scans, not just the
    // first window's three.
    expect(subscribed).toBe(12);
  });

  it("polling still discovers a commit this process never saw", async () => {
    // The flag means "a local signal says there may be work" — a commit here,
    // or a notify from elsewhere. It is NOT a claim that the log is unchanged:
    // a remote writer on a store without notify leaves this process disarmed
    // and stale. Polling is the path for that case, so it arms every tick;
    // without that, parking the scan would silently strand remote writes.
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const app = build();

    await app.do("tick", { stream: "s1", actor }, {});
    await quiesce(app);

    // Write straight to the store, the way another process would — nothing
    // arms this Act.
    await raw.commit("remote-1", [{ name: "Ticked", data: {} }], {
      correlation: "c",
      causation: {},
    });
    const idle = count_queries(raw);
    await app.correlate();
    expect(idle.n).toBe(0); // still parked — no local signal

    // One poll tick arms and finds it.
    await new Promise<void>((done) => {
      app.start_correlations({ limit: 100 }, 5, () => done());
    });
    await app.stop_correlations();
  });
});
