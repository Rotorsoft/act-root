/**
 * #1484 — the correlate checkpoint is durable and single-writer.
 *
 * It used to live in process memory, so every worker re-scanned the same
 * event range and issued the same `subscribe` UPSERTs, and a restart resumed
 * from a heuristic (the subscription watermark minus a back-scan) rather than
 * from where the scan actually reached.
 */
import { act, dispose, InMemoryStore, state, store } from "@rotorsoft/act";
import { afterEach, describe, expect, it } from "vitest";
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
const peek = async (s: InMemoryStore) => (await s.subscribe([])).correlated_at;

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
});

/**
 * Count the events a scan actually reads. Re-scanning is the only observable
 * difference the durable checkpoint makes: a restart converges on the same
 * `subscribed` count and the same `last_id` either way — the store's UPSERT
 * is idempotent and the ids are the same ids — so asserting on those proves
 * nothing. The work is what changes.
 */
const count_scanned = (s: InMemoryStore) => {
  const counter = { n: 0 };
  const original = s.query.bind(s);
  s.query = ((cb: (e: never) => void, q: never) =>
    original((e) => {
      counter.n++;
      cb(e as never);
    }, q)) as typeof s.query;
  return counter;
};

describe("the checkpoint survives a restart", () => {
  it("resumes where the previous process stopped, re-reading nothing", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();

    const w1 = worker();
    await w1.do("tick", { stream: "src", actor }, {});
    const first = await w1.correlate();
    expect(first.subscribed).toBe(1);
    await w1.shutdown();

    // A new process over the same store: its correlate must not re-scan the
    // range the first one already covered. Without the durable checkpoint it
    // cold-starts from the subscription watermark backed off by the
    // back-scan window — which, with the target still undrained at -1, is
    // the whole log.
    const scanned = count_scanned(raw);
    const w2 = worker();
    const second = await w2.correlate();
    expect(scanned.n).toBe(0);
    expect(second.subscribed).toBe(0);
    expect(second.last_id).toBe(first.last_id);
  });

  it("picks up events committed after the checkpoint, and only those", async () => {
    const raw = new InMemoryStore();
    store(raw);
    await store().seed();
    const w1 = worker();
    await w1.do("tick", { stream: "a", actor }, {});
    await w1.correlate();
    await w1.shutdown();

    const w2 = worker();
    await w2.do("tick", { stream: "b", actor }, {});
    // `do` reads the stream to fold state, so count only the scan.
    const scanned = count_scanned(raw);
    const after = await w2.correlate();
    expect(after.subscribed).toBe(1);
    // The one new event, not the one the first process already correlated.
    expect(scanned.n).toBe(1);
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
