/**
 * #1484 — the correlate checkpoint is durable and single-writer.
 *
 * It used to live in process memory, so every worker re-scanned the same
 * event range and issued the same `subscribe` UPSERTs, and a restart resumed
 * from a heuristic (the subscription watermark minus a back-scan) rather than
 * from where the scan actually reached.
 */
import {
  act,
  CORRELATE_LANE,
  CORRELATE_STREAM,
  dispose,
  InMemoryStore,
  state,
  store,
} from "@rotorsoft/act";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const ZodEmpty = z.object({});

const Ticker = state({ Ticker: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_, s) => ({ n: s.n + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

/** Lease the checkpoint through the reserved lane, the way correlate does. */
const lease = (s: InMemoryStore, by: string, millis = 5_000) =>
  s.claim(1, 0, by, millis, CORRELATE_LANE);

/** Advance + release, or just release when `at` is unchanged. */
const release = (s: InMemoryStore, by: string, at: number) =>
  s.ack([
    {
      stream: CORRELATE_STREAM,
      source: undefined,
      at,
      retry: -1,
      by,
      lagging: true,
    },
  ]);

/** Read without leaving a lease behind. */
const peek = async (s: InMemoryStore) => {
  const [l] = await lease(s, `peek-${Math.random()}`);
  if (!l) return undefined;
  await release(s, l.by, l.at);
  return l.at;
};

/** An Act whose dynamic resolver makes correlate actually scan. */
const worker = () =>
  act()
    .withState(Ticker)
    .on("Ticked")
    .do(async function noop() {})
    .to((e) => ({ target: `dyn-${e.stream}` }))
    .build();

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
});

describe("the checkpoint survives a restart", () => {
  it("resumes where the previous process stopped", async () => {
    store(new InMemoryStore());
    await store().seed();

    const w1 = worker();
    await w1.do("tick", { stream: "src", actor }, {});
    const first = await w1.correlate();
    expect(first.subscribed).toBe(1);
    await w1.shutdown();

    // A new process over the same store: its correlate must not re-scan the
    // range the first one already covered.
    const w2 = worker();
    const second = await w2.correlate();
    expect(second.subscribed).toBe(0);
    expect(second.last_id).toBe(first.last_id);
  });

  it("picks up events committed after the checkpoint", async () => {
    store(new InMemoryStore());
    await store().seed();
    const w1 = worker();
    await w1.do("tick", { stream: "a", actor }, {});
    await w1.correlate();
    await w1.shutdown();

    const w2 = worker();
    await w2.do("tick", { stream: "b", actor }, {});
    const after = await w2.correlate();
    expect(after.subscribed).toBe(1);
  });
});

describe("one correlator scans at a time", () => {
  it("a second worker skips the scan instead of repeating it", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();

    const w1 = worker();
    const w2 = worker();
    await w1.do("tick", { stream: "src", actor }, {});

    // Hold the checkpoint lease out from under w1/w2, the way a peer
    // correlator mid-scan would.
    const [held] = await lease(raw, "peer", 30_000);
    expect(held).toBeDefined();

    const scan = await w1.correlate();
    expect(scan.subscribed).toBe(0);

    // Released — the next scan proceeds and discovers the target.
    await release(raw, "peer", held.at);
    expect((await w2.correlate()).subscribed).toBe(1);
  });

  it("releases the lease when the scan throws, rather than parking it", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const w1 = worker();
    await w1.do("tick", { stream: "src", actor }, {});

    // A store failure mid-scan must not hold the checkpoint for a whole
    // lease window — that would stall correlation for every worker.
    const boom = vi
      .spyOn(raw, "subscribe")
      .mockRejectedValueOnce(new Error("subscribe failed"));
    await expect(w1.correlate()).rejects.toThrow("subscribe failed");
    boom.mockRestore();

    // Lease is free, and the checkpoint did not advance past the failed scan.
    expect(await peek(raw)).toBe(-1);

    // The retry succeeds and discovers the target.
    expect((await w1.correlate()).subscribed).toBe(1);
  });
});

describe("a static-only app never touches the checkpoint", () => {
  it("leaves it untouched", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const app = act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function noop() {})
      .to({ target: "out" })
      .build();

    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();

    expect(await peek(raw)).toBe(-1);
  });
});
