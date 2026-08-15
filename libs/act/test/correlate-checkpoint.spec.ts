/**
 * #1484 — the correlate checkpoint is durable and single-writer.
 *
 * It used to live in process memory, so every worker re-scanned the same
 * event range and issued the same `subscribe` UPSERTs, and a restart resumed
 * from a heuristic (the subscription watermark minus a back-scan) rather than
 * from where the scan actually reached.
 */
import { act, dispose, InMemoryStore, state, store } from "@rotorsoft/act";
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

/** An Act whose dynamic resolver makes correlate actually scan. */
const worker = () =>
  act()
    .withState(Ticker)
    .on("Ticked")
    .do(async function noop() {})
    .to((e) => ({ target: `dyn-${e.stream}` }))
    .build();

/** The checkpoint rides subscribe's return (#1484). */
const peek = async (s: InMemoryStore) => (await s.subscribe([])).correlated;

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

describe("the checkpoint is persisted by correlate's own subscribe", () => {
  it("advances as soon as a scan registers what it found", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const w1 = worker();
    await w1.do("tick", { stream: "src", actor }, {});

    // No drain needed: correlate persists its cursor in the same subscribe
    // that registers the targets it discovered.
    const scan = await w1.correlate();
    expect(scan.subscribed).toBe(1);
    expect(await peek(raw)).toBe(scan.last_id);
  });

  it("never regresses on a later, lower value", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    await raw.subscribe([], 50);
    await raw.subscribe([], 10);
    expect(await peek(raw)).toBe(50);
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
