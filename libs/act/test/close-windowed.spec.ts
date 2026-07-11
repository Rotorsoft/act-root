import { z } from "zod";
import {
  act,
  cache,
  dispose,
  SNAP_EVENT,
  state,
  store,
  TOMBSTONE_EVENT,
} from "../src/index.js";
import { run_close_cycle } from "../src/internal/close-cycle.js";

/**
 * Windowed close (#1011): `app.close([{ stream, before }])` prunes the
 * prefix below the closest safe `__snapshot__` instead of retiring the
 * stream — no tombstone guard, no seed, cache untouched, stream stays
 * live. These exercise the orchestrator branch; the store-level
 * boundary semantics live in the TCK.
 */
describe("windowed close", () => {
  // Snapshot every 2 patches so streams grow real `__snapshot__`
  // boundaries as they act.
  const counter = state({ WCounter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: z.object({ by: z.number() }) })
    .patch({ ticked: ({ data }, s) => ({ count: s.count + data.by }) })
    .on({ tick: z.object({ by: z.number() }) })
    .emit((action) => ["ticked", { by: action.by }])
    .snap((s) => s.patches >= 2)
    .build();

  const app = act()
    .withState(counter)
    .on("ticked")
    .do(async function onTicked() {
      await Promise.resolve();
    })
    .to("w-reaction-target")
    .build();

  const actor = { id: "test", name: "Test" };
  const future = () => new Date(Date.now() + 60_000);

  async function drainAll() {
    await app.correlate();
    let d = await app.drain();
    while (d.acked.length) d = await app.drain();
  }

  async function tick(stream: string, times: number) {
    for (let i = 0; i < times; i++)
      await app.do("tick", { stream, actor }, { by: 1 });
  }

  async function events_of(stream: string) {
    const out: { name: string; id: number }[] = [];
    await store().query((e) => out.push({ name: e.name, id: e.id }), {
      stream,
      stream_exact: true,
      with_snaps: true,
      after: -1,
    });
    return out;
  }

  beforeEach(async () => {
    await store().seed();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("prunes the prefix behind the boundary snapshot and keeps the stream live", async () => {
    await tick("w1", 7);
    await drainAll();
    const pre = await events_of("w1");
    const snaps = pre.filter((e) => e.name === SNAP_EVENT);
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    const boundary = snaps.at(-1)!;
    const before = future();

    const { truncated, skipped } = await app.close([{ stream: "w1", before }]);

    expect(skipped).toEqual([]);
    const entry = truncated.get("w1")!;
    expect(entry.before).toEqual(before);
    expect(entry.committed.name).toBe(SNAP_EVENT);
    expect(entry.committed.id).toBe(boundary.id);
    expect(entry.deleted).toBe(pre.filter((e) => e.id < boundary.id).length);

    // Earliest surviving event is the boundary snapshot; tail intact.
    const post = await events_of("w1");
    expect(post[0].id).toBe(boundary.id);
    expect(post.some((e) => e.name === TOMBSTONE_EVENT)).toBe(false);

    // Replay from the truncated log reproduces the same state.
    await cache().clear();
    const snap = await app.load(counter, "w1");
    expect(snap.state.count).toBe(7);

    // The stream keeps accepting actions — no StreamClosedError.
    await app.do("tick", { stream: "w1", actor }, { by: 1 });
    await cache().clear();
    const again = await app.load(counter, "w1");
    expect(again.state.count).toBe(8);
  });

  it("emits the closed lifecycle event with the windowed entry", async () => {
    const closed: unknown[] = [];
    app.on("closed", (r) => closed.push(r));
    await tick("w2", 5);
    await drainAll();
    await app.close([{ stream: "w2", before: future() }]);
    expect(closed).toHaveLength(1);
    const result = closed[0] as {
      truncated: Map<string, { before?: Date }>;
    };
    expect(result.truncated.get("w2")?.before).toBeInstanceOf(Date);
  });

  it("skips streams with no qualifying snapshot", async () => {
    // Only 1 event — the snap predicate (patches >= 2) never fired.
    await tick("w3", 1);
    await drainAll();
    const { truncated, skipped } = await app.close([
      { stream: "w3", before: future() },
    ]);
    expect(truncated.size).toBe(0);
    expect(skipped).toEqual(["w3"]);

    // A cutoff older than every snapshot skips too.
    await tick("w3", 5);
    await drainAll();
    const early = await app.close([{ stream: "w3", before: new Date(0) }]);
    expect(early.skipped).toEqual(["w3"]);
  });

  it("caps the boundary at a lagging consumer's watermark", async () => {
    // No drain: the reaction subscription registers during the close's
    // correlate() with watermark -1, so no snapshot can satisfy
    // `id <= max_id` and the prune no-ops.
    await tick("w4", 5);
    const { truncated, skipped } = await app.close([
      { stream: "w4", before: future() },
    ]);
    expect(truncated.size).toBe(0);
    expect(skipped).toEqual(["w4"]);

    // Once the consumer catches up, the same close prunes.
    await drainAll();
    const retry = await app.close([{ stream: "w4", before: future() }]);
    expect(retry.truncated.get("w4")?.committed.name).toBe(SNAP_EVENT);
  });

  it("runs the archive callback before the truncate, against intact history", async () => {
    await tick("w5", 5);
    await drainAll();
    const seen: number[] = [];
    await app.close([
      {
        stream: "w5",
        before: future(),
        archive: async () => {
          seen.push((await events_of("w5")).length);
        },
      },
    ]);
    const post = await events_of("w5");
    expect(seen).toHaveLength(1);
    // Archive saw strictly more events than survive the prune.
    expect(seen[0]).toBeGreaterThan(post.length);
  });

  it("mixes windowed and full targets in one call", async () => {
    await tick("w6", 5);
    // 3 ticks so w7's head is a domain event, not a trailing snapshot —
    // the full-close tombstone guard expects the stream version at the
    // scanned (non-snap) head.
    await tick("w7", 3);
    await drainAll();
    const { truncated, skipped } = await app.close([
      { stream: "w6", before: future() },
      { stream: "w7" },
    ]);
    expect(skipped).toEqual([]);
    expect(truncated.get("w6")?.committed.name).toBe(SNAP_EVENT);
    expect(truncated.get("w6")?.before).toBeInstanceOf(Date);
    expect(truncated.get("w7")?.committed.name).toBe(TOMBSTONE_EVENT);
    expect(truncated.get("w7")?.before).toBeUndefined();
  });

  it("rejects `before` combined with `restart`", async () => {
    await expect(
      app.close([{ stream: "w8", before: future(), restart: true }])
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("leaves the cache untouched — no invalidation on prune", async () => {
    await tick("w9", 5);
    await drainAll();
    const cached = await cache().get("w9");
    expect(cached).toBeDefined();
    await app.close([{ stream: "w9", before: future() }]);
    expect(await cache().get("w9")).toEqual(cached);
  });

  it("pages the min-watermark probe and matches consumers per target", async () => {
    await tick("w10", 5);
    await tick("w12", 5);
    await drainAll();
    // Several extra subscriptions force multi-page keyset pagination
    // with probe_page_size: 1. wp-c consumes only w12, so during the
    // probe its source matches one target and not the other.
    await store().subscribe([
      { stream: "wp-a", source: "w10" },
      { stream: "wp-b", source: "w10" },
      { stream: "wp-c", source: "w12" },
    ]);
    const result = await run_close_cycle(
      [
        { stream: "w10", before: future() },
        { stream: "w12", before: future() },
      ],
      {
        reactive_events_size: 1,
        event_to_state: new Map(),
        load: (() => {
          throw new Error("unused");
        }) as never,
        tombstone: (() => {
          throw new Error("unused");
        }) as never,
        logger: console as never,
        correlation: "test",
        probe_page_size: 1,
      }
    );
    // Fresh subscriptions sit at -1 → boundary capped below every
    // snapshot → skipped. The multi-page loop still visited them all.
    expect(result.skipped.sort()).toEqual(["w10", "w12"]);
  });

  it("fires the archive callback at most once when two windowed closes race the same stream", async () => {
    // Ticket #1222: a manual `app.close([{stream, before}])` racing an
    // `.autocloses` windowed close for the same stream both take the
    // guard-free windowed branch, so the archive callback (double S3
    // upload / double JSONL append) fires TWICE for the overlapping
    // prefix. Reproduce with two concurrent `app.close` calls — the manual
    // path bypasses the autoclose lease, so both run `run_close_cycle`
    // directly against the same stream.
    await tick("w13", 6);
    await drainAll();
    let archived = 0;
    const before = future();
    const archive = async () => {
      // Simulate a real archiver's async I/O so both closers interleave
      // between the archive step and the truncate.
      await Promise.resolve();
      archived++;
    };
    await Promise.all([
      app.close([{ stream: "w13", before, archive }]),
      app.close([{ stream: "w13", before, archive }]),
    ]);
    expect(archived).toBe(1);
  });

  it("prunes purely by date when the app has no reactions", async () => {
    const solo = act().withState(counter).build();
    for (let i = 0; i < 5; i++)
      await solo.do("tick", { stream: "w11", actor }, { by: 1 });
    const { truncated, skipped } = await solo.close([
      { stream: "w11", before: future() },
    ]);
    expect(skipped).toEqual([]);
    expect(truncated.get("w11")?.committed.name).toBe(SNAP_EVENT);
  });
});
